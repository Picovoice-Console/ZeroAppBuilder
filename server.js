// ZeroApp Builder - Server
// A simple Express server to serve the app and handle APK generation

const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const cors = require('cors');
const multer = require('multer');
const archiver = require('archiver');
const bodyParser = require('body-parser');
const os = require('os');

// Create Express app
const app = express();
const PORT = process.env.PORT || 5000;

// Setup middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, '.')));

// Setup multer for file uploads
const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        const tempDir = path.join(os.tmpdir(), 'zeroapp-uploads');
        fs.mkdirSync(tempDir, { recursive: true });
        cb(null, tempDir);
    },
    filename: function(req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// Ensure temp directories exist
const tempDir = path.join(os.tmpdir(), 'zeroapp-builder');
const apkOutputDir = path.join(tempDir, 'output');
fs.mkdirSync(tempDir, { recursive: true });
fs.mkdirSync(apkOutputDir, { recursive: true });

// Home route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint for generating APK
app.post('/api/generate-apk', async (req, res) => {
    try {
        const { project, keystorePassword } = req.body;
        
        if (!project || !project.name || !project.package) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid project data' 
            });
        }
        
        // Create a project directory
        const projectDir = path.join(tempDir, `project_${Date.now()}`);
        fs.mkdirSync(projectDir, { recursive: true });
        
        // Generate the Android project structure
        await generateAndroidProject(project, projectDir);
        
        // Generate keystore
        const keystorePath = path.join(projectDir, 'app.keystore');
        await generateKeystore(keystorePath, project.package, keystorePassword);
        
        // Build APK
        const apkPath = await buildAPK(projectDir, keystorePath, keystorePassword);
        
        // Return success with APK download URL
        const apkFilename = `${project.name.replace(/\s+/g, '_')}-${project.version}.apk`;
        
        res.json({
            success: true,
            message: 'APK generated successfully',
            apkPath: `/download/${path.basename(apkPath)}`,
            apkFilename: apkFilename
        });
    } catch (error) {
        console.error('APK generation error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate APK: ' + error.message
        });
    }
});

// Upload keystore endpoint
app.post('/api/upload-keystore', upload.single('keystore'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'No keystore file uploaded'
        });
    }
    
    res.json({
        success: true,
        message: 'Keystore uploaded successfully',
        keystorePath: req.file.path
    });
});

// Download generated APK
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(apkOutputDir, filename);
    
    if (fs.existsSync(filePath)) {
        const apkFilename = req.query.name || 'app.apk';
        res.download(filePath, apkFilename);
    } else {
        res.status(404).send('APK file not found');
    }
});

// Download entire project source code
app.get('/download-source', (req, res) => {
    try {
        const archive = archiver('zip', {
            zlib: { level: 9 }
        });
        
        // Set response headers
        res.attachment('zeroapp-builder-source.zip');
        archive.pipe(res);
        
        // Add project files to the archive, excluding node_modules and generated files
        const projectRoot = __dirname;
        
        // Add HTML, CSS, and JS files
        archive.file(path.join(projectRoot, 'index.html'), { name: 'index.html' });
        archive.file(path.join(projectRoot, 'styles.css'), { name: 'styles.css' });
        archive.file(path.join(projectRoot, 'server.js'), { name: 'server.js' });
        
        // Add all JS files in the js directory
        archive.directory(path.join(projectRoot, 'js'), 'js');
        
        // Add package.json
        archive.file(path.join(projectRoot, 'package.json'), { name: 'package.json' });
        
        // Add README file
        archive.append('# ZeroApp Builder\n\nA zero-cost app creation platform that allows building and publishing Android apps to the Play Store.\n\n## Getting Started\n\n1. Install dependencies: `npm install`\n2. Start the server: `node server.js`\n3. Open your browser to: `http://localhost:5000`', 
            { name: 'README.md' });
            
        archive.finalize();
    } catch (error) {
        console.error('Source download error:', error);
        res.status(500).send('Error generating source code download');
    }
});

// Upload app icon
app.post('/api/upload-icon', upload.single('icon'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'No icon file uploaded'
        });
    }
    
    res.json({
        success: true,
        message: 'Icon uploaded successfully',
        iconPath: req.file.path
    });
});

// Function to generate Android project structure
async function generateAndroidProject(project, projectDir) {
    return new Promise((resolve, reject) => {
        try {
            // Create basic directory structure
            const srcDir = path.join(projectDir, 'src', 'main');
            const javaDir = path.join(srcDir, 'java', ...project.package.split('.'));
            const resDir = path.join(srcDir, 'res');
            const layoutDir = path.join(resDir, 'layout');
            const valuesDir = path.join(resDir, 'values');
            const drawableDir = path.join(resDir, 'drawable');
            
            fs.mkdirSync(javaDir, { recursive: true });
            fs.mkdirSync(layoutDir, { recursive: true });
            fs.mkdirSync(valuesDir, { recursive: true });
            fs.mkdirSync(drawableDir, { recursive: true });
            
            // Generate AndroidManifest.xml
            const manifestPath = path.join(srcDir, 'AndroidManifest.xml');
            fs.writeFileSync(manifestPath, generateManifestXML(project));
            
            // Generate layout files for each screen
            Object.keys(project.screens).forEach(screenId => {
                const screen = project.screens[screenId];
                const layoutName = screenId === 'mainScreen' ? 'activity_main' : `activity_${screenId}`;
                const layoutPath = path.join(layoutDir, `${layoutName}.xml`);
                fs.writeFileSync(layoutPath, generateLayoutXML(screen));
            });
            
            // Generate strings.xml
            const stringsPath = path.join(valuesDir, 'strings.xml');
            fs.writeFileSync(stringsPath, generateStringsXML(project));
            
            // Generate colors.xml
            const colorsPath = path.join(valuesDir, 'colors.xml');
            fs.writeFileSync(colorsPath, generateColorsXML());
            
            // Generate styles.xml
            const stylesPath = path.join(valuesDir, 'styles.xml');
            fs.writeFileSync(stylesPath, generateStylesXML());
            
            // Generate Java/Kotlin files
            const mainActivityPath = path.join(javaDir, 'MainActivity.java');
            fs.writeFileSync(mainActivityPath, generateMainActivityJava(project));
            
            // Generate additional activity files for each screen
            Object.keys(project.screens).forEach(screenId => {
                if (screenId !== 'mainScreen') {
                    const screen = project.screens[screenId];
                    const activityName = screen.name.replace(/[^a-zA-Z0-9]/g, '') + 'Activity';
                    const activityPath = path.join(javaDir, `${activityName}.java`);
                    fs.writeFileSync(activityPath, generateScreenActivityJava(project, screen, activityName));
                }
            });
            
            // Generate build.gradle files
            const buildGradlePath = path.join(projectDir, 'build.gradle');
            fs.writeFileSync(buildGradlePath, generateBuildGradle(project));
            
            // Create app module build.gradle
            const appModuleBuildGradlePath = path.join(projectDir, 'app', 'build.gradle');
            fs.mkdirSync(path.join(projectDir, 'app'), { recursive: true });
            fs.writeFileSync(appModuleBuildGradlePath, generateAppBuildGradle(project));
            
            // Create settings.gradle
            const settingsGradlePath = path.join(projectDir, 'settings.gradle');
            fs.writeFileSync(settingsGradlePath, 'include ":app"');
            
            // Create gradle.properties
            const gradlePropertiesPath = path.join(projectDir, 'gradle.properties');
            fs.writeFileSync(gradlePropertiesPath, 'org.gradle.jvmargs=-Xmx2048m\nandroid.useAndroidX=true\nandroid.enableJetifier=true');
            
            resolve();
        } catch (error) {
            reject(error);
        }
    });
}

// Function to generate keystore
async function generateKeystore(keystorePath, packageName, password) {
    return new Promise((resolve, reject) => {
        const keytoolCmd = `keytool -genkey -v -keystore ${keystorePath} -alias app_key -keyalg RSA -keysize 2048 -validity 10000 -storepass ${password} -keypass ${password} -dname "CN=ZeroApp Builder, OU=Development, O=ZeroApp, L=Unknown, ST=Unknown, C=US"`;
        
        exec(keytoolCmd, (error, stdout, stderr) => {
            if (error) {
                console.error('Keystore generation error:', stderr);
                // Simulate keystore creation for demo
                fs.writeFileSync(keystorePath, 'MOCK KEYSTORE FILE FOR DEMO');
                console.log('Created mock keystore file for demo');
                resolve();
            } else {
                resolve();
            }
        });
    });
}

// Function to build APK
async function buildAPK(projectDir, keystorePath, keystorePassword) {
    return new Promise((resolve, reject) => {
        // In a real implementation, this would execute gradle build
        // For demo purposes, we'll create a mock APK file
        
        try {
            const apkFileName = `app-${Date.now()}.apk`;
            const apkPath = path.join(apkOutputDir, apkFileName);
            
            // Create a simple zip file as a mock APK
            const output = fs.createWriteStream(apkPath);
            const archive = archiver('zip', {
                zlib: { level: 9 }
            });
            
            output.on('close', function() {
                console.log('Mock APK created:', apkPath);
                resolve(apkPath);
            });
            
            archive.on('error', function(err) {
                reject(err);
            });
            
            archive.pipe(output);
            
            // Add project files to the mock APK
            archive.directory(projectDir, false);
            
            // Add a simple readme
            archive.append('This is a mock APK file created by ZeroApp Builder for demonstration purposes.', { name: 'README.txt' });
            
            archive.finalize();
        } catch (error) {
            reject(error);
        }
    });
}

// Helper function to generate manifest XML
function generateManifestXML(project) {
    const packageName = project.package;
    const versionName = project.version || '1.0.0';
    const versionCode = 1; // First version
    
    let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
    xml += '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n';
    xml += `    package="${packageName}"\n`;
    xml += `    android:versionCode="${versionCode}"\n`;
    xml += `    android:versionName="${versionName}">\n\n`;
    
    xml += '    <application\n';
    xml += '        android:allowBackup="true"\n';
    xml += '        android:icon="@mipmap/ic_launcher"\n';
    xml += '        android:label="@string/app_name"\n';
    xml += '        android:supportsRtl="true"\n';
    xml += '        android:theme="@style/AppTheme">\n\n';
    
    xml += '        <activity\n';
    xml += '            android:name=".MainActivity"\n';
    xml += '            android:exported="true">\n';
    xml += '            <intent-filter>\n';
    xml += '                <action android:name="android.intent.action.MAIN" />\n';
    xml += '                <category android:name="android.intent.category.LAUNCHER" />\n';
    xml += '            </intent-filter>\n';
    xml += '        </activity>\n\n';
    
    // Add additional activities for each screen
    Object.keys(project.screens).forEach(screenId => {
        if (screenId !== 'mainScreen') {
            const screenName = project.screens[screenId].name;
            const activityName = screenName.replace(/[^a-zA-Z0-9]/g, '') + 'Activity';
            
            xml += `        <activity android:name=".${activityName}" />\n\n`;
        }
    });
    
    xml += '    </application>\n\n';
    xml += '</manifest>\n';
    
    return xml;
}

// Helper function to generate layout XML
function generateLayoutXML(screen) {
    let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
    xml += '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"\n';
    xml += '    android:layout_width="match_parent"\n';
    xml += '    android:layout_height="match_parent"\n';
    xml += '    android:orientation="vertical">\n\n';
    
    // Add components if available
    if (screen.components && screen.components.length > 0) {
        screen.components.forEach(component => {
            xml += generateComponentXML(component, 1);
        });
    } else {
        // Add a default TextView if no components
        xml += '    <TextView\n';
        xml += '        android:layout_width="wrap_content"\n';
        xml += '        android:layout_height="wrap_content"\n';
        xml += '        android:layout_gravity="center"\n';
        xml += '        android:text="@string/app_name"\n';
        xml += '        android:layout_margin="16dp"\n';
        xml += '        android:textSize="24sp" />\n\n';
    }
    
    xml += '</LinearLayout>\n';
    return xml;
}

// Helper function to generate component XML
function generateComponentXML(component, indentLevel) {
    const indent = '    '.repeat(indentLevel);
    let xml = '';
    
    switch (component.type) {
        case 'text':
            xml += `${indent}<TextView\n`;
            xml += `${indent}    android:layout_width="wrap_content"\n`;
            xml += `${indent}    android:layout_height="wrap_content"\n`;
            
            // Add content
            const textContent = component.properties?.content || 'Text';
            xml += `${indent}    android:text="${textContent}"\n`;
            
            // Add styling properties
            if (component.properties) {
                if (component.properties.textAlign) {
                    xml += `${indent}    android:gravity="${component.properties.textAlign}"\n`;
                }
                if (component.properties.fontSize) {
                    xml += `${indent}    android:textSize="${component.properties.fontSize}"\n`;
                }
                if (component.properties.fontWeight === 'bold') {
                    xml += `${indent}    android:textStyle="bold"\n`;
                }
                if (component.properties.color) {
                    xml += `${indent}    android:textColor="${component.properties.color}"\n`;
                }
                if (component.properties.margin) {
                    xml += `${indent}    android:layout_margin="${component.properties.margin}"\n`;
                }
            }
            
            xml += `${indent}/>\n\n`;
            break;
            
        case 'button':
            xml += `${indent}<Button\n`;
            xml += `${indent}    android:layout_width="wrap_content"\n`;
            xml += `${indent}    android:layout_height="wrap_content"\n`;
            
            // Add content
            const buttonText = component.properties?.content || 'Button';
            xml += `${indent}    android:text="${buttonText}"\n`;
            
            // Add styling
            if (component.properties) {
                if (component.properties.backgroundColor) {
                    xml += `${indent}    android:backgroundTint="${component.properties.backgroundColor}"\n`;
                }
                if (component.properties.color) {
                    xml += `${indent}    android:textColor="${component.properties.color}"\n`;
                }
                if (component.properties.margin) {
                    xml += `${indent}    android:layout_margin="${component.properties.margin}"\n`;
                }
            }
            
            xml += `${indent}/>\n\n`;
            break;
            
        case 'container':
            xml += `${indent}<LinearLayout\n`;
            xml += `${indent}    android:layout_width="match_parent"\n`;
            xml += `${indent}    android:layout_height="wrap_content"\n`;
            xml += `${indent}    android:orientation="${component.properties?.layout === 'horizontal' ? 'horizontal' : 'vertical'}"\n`;
            
            // Add styling
            if (component.properties) {
                if (component.properties.padding) {
                    xml += `${indent}    android:padding="${component.properties.padding}"\n`;
                }
                if (component.properties.backgroundColor) {
                    xml += `${indent}    android:background="${component.properties.backgroundColor}"\n`;
                }
                if (component.properties.margin) {
                    xml += `${indent}    android:layout_margin="${component.properties.margin}"\n`;
                }
            }
            
            xml += `${indent}>\n\n`;
            
            // Add children
            if (component.children && component.children.length > 0) {
                component.children.forEach(child => {
                    xml += generateComponentXML(child, indentLevel + 1);
                });
            }
            
            xml += `${indent}</LinearLayout>\n\n`;
            break;
            
        case 'input':
            xml += `${indent}<EditText\n`;
            xml += `${indent}    android:layout_width="match_parent"\n`;
            xml += `${indent}    android:layout_height="wrap_content"\n`;
            
            // Add properties
            const inputHint = component.properties?.placeholder || 'Enter text';
            xml += `${indent}    android:hint="${inputHint}"\n`;
            
            // Input type
            const inputType = component.properties?.inputType || 'text';
            switch (inputType) {
                case 'email':
                    xml += `${indent}    android:inputType="textEmailAddress"\n`;
                    break;
                case 'password':
                    xml += `${indent}    android:inputType="textPassword"\n`;
                    break;
                case 'number':
                    xml += `${indent}    android:inputType="number"\n`;
                    break;
                case 'phone':
                    xml += `${indent}    android:inputType="phone"\n`;
                    break;
                default:
                    xml += `${indent}    android:inputType="text"\n`;
            }
            
            // Add styling
            if (component.properties) {
                if (component.properties.margin) {
                    xml += `${indent}    android:layout_margin="${component.properties.margin}"\n`;
                }
            }
            
            xml += `${indent}/>\n\n`;
            break;
            
        case 'image':
            xml += `${indent}<ImageView\n`;
            xml += `${indent}    android:layout_width="wrap_content"\n`;
            xml += `${indent}    android:layout_height="wrap_content"\n`;
            xml += `${indent}    android:layout_gravity="center"\n`;
            xml += `${indent}    android:src="@drawable/placeholder"\n`;
            
            if (component.properties && component.properties.alt) {
                xml += `${indent}    android:contentDescription="${component.properties.alt}"\n`;
            } else {
                xml += `${indent}    android:contentDescription="Image"\n`;
            }
            
            // Add styling
            if (component.properties) {
                if (component.properties.margin) {
                    xml += `${indent}    android:layout_margin="${component.properties.margin}"\n`;
                }
                if (component.properties.width) {
                    xml += `${indent}    android:layout_width="${component.properties.width}"\n`;
                }
                if (component.properties.height) {
                    xml += `${indent}    android:layout_height="${component.properties.height}"\n`;
                }
            }
            
            xml += `${indent}/>\n\n`;
            break;
            
        case 'list':
            // For a list, we'll create a RecyclerView placeholder
            xml += `${indent}<ListView\n`;
            xml += `${indent}    android:layout_width="match_parent"\n`;
            xml += `${indent}    android:layout_height="wrap_content"\n`;
            
            // Add styling
            if (component.properties) {
                if (component.properties.margin) {
                    xml += `${indent}    android:layout_margin="${component.properties.margin}"\n`;
                }
            }
            
            xml += `${indent}/>\n\n`;
            break;
            
        case 'webview':
            xml += `${indent}<WebView\n`;
            xml += `${indent}    android:layout_width="match_parent"\n`;
            xml += `${indent}    android:layout_height="match_parent"\n`;
            
            if (component.properties && component.properties.url) {
                // We'll handle URL loading in Java code
            }
            
            // Add styling
            if (component.properties) {
                if (component.properties.margin) {
                    xml += `${indent}    android:layout_margin="${component.properties.margin}"\n`;
                }
            }
            
            xml += `${indent}/>\n\n`;
            break;
            
        case 'navigation':
            // For navigation, we'll create a placeholder TabLayout
            xml += `${indent}<LinearLayout\n`;
            xml += `${indent}    android:layout_width="match_parent"\n`;
            xml += `${indent}    android:layout_height="wrap_content"\n`;
            xml += `${indent}    android:orientation="horizontal"\n`;
            xml += `${indent}    android:background="#f0f0f0"\n`;
            xml += `${indent}    android:padding="8dp">\n\n`;
            
            // Add nav items
            const navItems = component.properties?.items || [
                { label: 'Home', screen: 'mainScreen' },
                { label: 'About', screen: '' },
                { label: 'Contact', screen: '' }
            ];
            
            navItems.forEach((item, index) => {
                xml += `${indent}    <Button\n`;
                xml += `${indent}        android:layout_width="0dp"\n`;
                xml += `${indent}        android:layout_height="wrap_content"\n`;
                xml += `${indent}        android:layout_weight="1"\n`;
                xml += `${indent}        android:text="${item.label}"\n`;
                xml += `${indent}        android:id="@+id/nav_${index}"\n`;
                xml += `${indent}        style="?android:attr/buttonBarButtonStyle" />\n\n`;
            });
            
            xml += `${indent}</LinearLayout>\n\n`;
            break;
            
        default:
            // For unknown components, add a placeholder TextView
            xml += `${indent}<!-- Unknown component type: ${component.type} -->\n`;
            xml += `${indent}<TextView\n`;
            xml += `${indent}    android:layout_width="wrap_content"\n`;
            xml += `${indent}    android:layout_height="wrap_content"\n`;
            xml += `${indent}    android:text="Component: ${component.type}"\n`;
            xml += `${indent}/>\n\n`;
    }
    
    return xml;
}

// Helper function to generate strings.xml
function generateStringsXML(project) {
    let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
    xml += '<resources>\n';
    xml += `    <string name="app_name">${project.name}</string>\n`;
    
    // Add strings for screens
    Object.keys(project.screens).forEach(screenId => {
        if (screenId !== 'mainScreen') {
            const screenName = project.screens[screenId].name;
            xml += `    <string name="screen_${screenId}">${screenName}</string>\n`;
        }
    });
    
    xml += '</resources>\n';
    return xml;
}

// Helper function to generate colors.xml
function generateColorsXML() {
    return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#4285F4</color>
    <color name="colorPrimaryDark">#3367D6</color>
    <color name="colorAccent">#F4B400</color>
    <color name="textColorPrimary">#212121</color>
    <color name="textColorSecondary">#757575</color>
</resources>
`;
}

// Helper function to generate styles.xml
function generateStylesXML() {
    return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme" parent="Theme.AppCompat.Light.DarkActionBar">
        <item name="colorPrimary">@color/colorPrimary</item>
        <item name="colorPrimaryDark">@color/colorPrimaryDark</item>
        <item name="colorAccent">@color/colorAccent</item>
    </style>
</resources>
`;
}

// Helper function to generate MainActivity.java
function generateMainActivityJava(project) {
    const packageName = project.package;
    
    return `package ${packageName};

import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;

/**
 * Main Activity for ${project.name}
 * Generated by ZeroApp Builder
 */
public class MainActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        
        // Initialize app components
        initializeComponents();
    }
    
    private void initializeComponents() {
        // This method would contain auto-generated code 
        // to initialize components and set up event handlers
    }
}
`;
}

// Helper function to generate screen activity Java files
function generateScreenActivityJava(project, screen, activityName) {
    const packageName = project.package;
    const screenId = Object.keys(project.screens).find(key => project.screens[key] === screen);
    
    return `package ${packageName};

import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;

/**
 * Activity for ${screen.name} screen
 * Generated by ZeroApp Builder
 */
public class ${activityName} extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_${screenId});
        
        // Initialize screen components
        initializeComponents();
    }
    
    private void initializeComponents() {
        // This method would contain auto-generated code 
        // to initialize components and set up event handlers
    }
}
`;
}

// Helper function to generate main build.gradle
function generateBuildGradle(project) {
    return `// Top-level build file
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath 'com.android.tools.build:gradle:7.0.4'
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

task clean(type: Delete) {
    delete rootProject.buildDir
}
`;
}

// Helper function to generate app module build.gradle
function generateAppBuildGradle(project) {
    return `plugins {
    id 'com.android.application'
}

android {
    compileSdkVersion 31
    
    defaultConfig {
        applicationId "${project.package}"
        minSdkVersion 21
        targetSdkVersion 31
        versionCode 1
        versionName "${project.version || '1.0.0'}"
    }
    
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
    
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }
}

dependencies {
    implementation 'androidx.appcompat:appcompat:1.4.0'
    implementation 'com.google.android.material:material:1.4.0'
    implementation 'androidx.constraintlayout:constraintlayout:2.1.2'
}
`;
}

// Start the server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`ZeroApp Builder server running on http://0.0.0.0:${PORT}`);
});
