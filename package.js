const fs = require('fs');
const path = require('path');
const https = require('https');
const archiver = require('archiver');

// Configuration
const SOURCE_DIR = path.join(__dirname, 'public');
const TARGET_DIR = path.join(__dirname, 'Quotely-v1.07');
const OUTPUT_ZIP = path.join(__dirname, 'Quotely-v1.07.zip');

// API endpoints
const CSS_MINIFY_API = 'https://www.toptal.com/developers/cssminifier/api/raw';
const JS_MINIFY_API = 'https://www.toptal.com/developers/javascript-minifier/api/raw';

// Helper function to make HTTP POST request
function minify(content, apiUrl) {
    return new Promise((resolve, reject) => {
        const postData = `input=${encodeURIComponent(content)}`;
        
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        
        const req = https.request(apiUrl, options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(data);
                } else {
                    reject(new Error(`API returned status ${res.statusCode}`));
                }
            });
        });
        
        req.on('error', (error) => {
            reject(error);
        });
        
        req.write(postData);
        req.end();
    });
}

// Recursively copy files and minify
async function processFiles(sourcePath, targetPath) {
    // Create target directory if it doesn't exist
    if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
    }
    
    const entries = fs.readdirSync(sourcePath, { withFileTypes: true });
    
    for (const entry of entries) {
        const sourceFilePath = path.join(sourcePath, entry.name);
        const targetFilePath = path.join(targetPath, entry.name);
        
        if (entry.isDirectory()) {
            // Recursively process subdirectories
            await processFiles(sourceFilePath, targetFilePath);
        } else {
            // Process individual files
            const ext = path.extname(entry.name).toLowerCase();
            const content = fs.readFileSync(sourceFilePath, 'utf8');
            
            console.log(`Processing: ${entry.name}`);
            
            try {
                if (ext === '.css') {
                    // Minify CSS
                    console.log(`  Minifying CSS...`);
                    const minified = await minify(content, CSS_MINIFY_API);
                    fs.writeFileSync(targetFilePath, minified, 'utf8');
                    console.log(`  ✓ Minified CSS: ${entry.name}`);
                } else if (ext === '.js') {
                    // Minify JavaScript
                    console.log(`  Minifying JavaScript...`);
                    const minified = await minify(content, JS_MINIFY_API);
                    fs.writeFileSync(targetFilePath, minified, 'utf8');
                    console.log(`  ✓ Minified JS: ${entry.name}`);
                } else {
                    // Copy other files as-is
                    fs.copyFileSync(sourceFilePath, targetFilePath);
                    console.log(`  ✓ Copied: ${entry.name}`);
                }
            } catch (error) {
                console.error(`  ✗ Error processing ${entry.name}:`, error.message);
                // Fallback: copy original file if minification fails
                fs.copyFileSync(sourceFilePath, targetFilePath);
                console.log(`  ⚠ Copied original file as fallback`);
            }
        }
    }
}

// Function to copy files as-is
async function copyFile(source, target) {
    const targetDir = path.dirname(target);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.copyFileSync(source, target);
}

// Function to copy directory recursively
function copyDirectory(source, target) {
    if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
    }
    
    const entries = fs.readdirSync(source, { withFileTypes: true });
    
    for (const entry of entries) {
        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        
        if (entry.isDirectory()) {
            copyDirectory(sourcePath, targetPath);
        } else {
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
}

// Function to create zip archive
async function createZip() {
    return new Promise((resolve, reject) => {
        console.log('\nCreating zip archive...');
        
        // Delete existing zip if it exists
        if (fs.existsSync(OUTPUT_ZIP)) {
            fs.unlinkSync(OUTPUT_ZIP);
        }
        
        const output = fs.createWriteStream(OUTPUT_ZIP);
        const archive = archiver('zip', {
            zlib: { level: 9 } // Maximum compression
        });
        
        output.on('close', () => {
            const sizeInMB = (archive.pointer() / 1024 / 1024).toFixed(2);
            console.log(`✓ Zip created: ${OUTPUT_ZIP} (${sizeInMB} MB)`);
            resolve();
        });
        
        archive.on('error', (err) => {
            reject(err);
        });
        
        archive.pipe(output);
        
        // Add all contents of Quotely-v1.07 directory to zip
        archive.directory(TARGET_DIR, 'Quotely-v1.07');
        
        archive.finalize();
    });
}

// Main execution
async function main() {
    console.log('Starting packaging process...\n');
    console.log(`Source: ${SOURCE_DIR}`);
    console.log(`Target: ${TARGET_DIR}\n`);
    
    try {
        // Step 1: Process public folder (minify CSS and JS)
        console.log('=== Step 1: Processing public folder ===');
        const publicTarget = path.join(TARGET_DIR, 'public');
        await processFiles(SOURCE_DIR, publicTarget);
        
        // Step 2: Copy package.json
        console.log('\n=== Step 2: Copying package.json ===');
        await copyFile(
            path.join(__dirname, 'package.json'),
            path.join(TARGET_DIR, 'package.json')
        );
        console.log('✓ Copied package.json');
        
        // Step 3: Copy manifest.json
        console.log('\n=== Step 3: Copying manifest.json ===');
        await copyFile(
            path.join(__dirname, 'manifest.json'),
            path.join(TARGET_DIR, 'manifest.json')
        );
        console.log('✓ Copied manifest.json');
        
        // Step 4: Copy media folder
        console.log('\n=== Step 4: Copying media folder ===');
        copyDirectory(
            path.join(__dirname, 'media'),
            path.join(TARGET_DIR, 'media')
        );
        console.log('✓ Copied media folder');
        
        // Step 5: Create zip archive
        await createZip();
        
        console.log('\n✓ All files processed and packaged successfully!');
    } catch (error) {
        console.error('\n✗ Error:', error.message);
        process.exit(1);
    }
}

main();
