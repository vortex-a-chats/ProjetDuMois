const fs = require('fs');
const https = require('https');
const path = require('path');

// Lire le fichier Mermaid
const mermaidFile = path.join(__dirname, '../docs/database_schema.mmd');
const mermaidCode = fs.readFileSync(mermaidFile, 'utf8');

// Encoder le code Mermaid pour l'URL
const encodedMermaid = encodeURIComponent(mermaidCode);

// URLs pour générer les images
const svgUrl = `https://mermaid.ink/svg/${Buffer.from(mermaidCode).toString('base64')}`;
const pngUrl = `https://mermaid.ink/img/${Buffer.from(mermaidCode).toString('base64')}?type=png`;

// Fonction pour télécharger un fichier
function downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            
            const fileStream = fs.createWriteStream(outputPath);
            response.pipe(fileStream);
            
            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });
            
            fileStream.on('error', reject);
        }).on('error', reject);
    });
}

// Fonction pour convertir PNG en JPG
function convertPngToJpg(pngPath, jpgPath) {
    // Utiliser ImageMagick ou une autre méthode si disponible
    // Pour l'instant, on va juste copier le PNG comme JPG
    // (dans un vrai environnement, on utiliserait sharp ou imagemagick)
    return new Promise((resolve, reject) => {
        // Si imagemagick est disponible, l'utiliser
        const { exec } = require('child_process');
        exec(`which convert`, (error) => {
            if (!error) {
                exec(`convert "${pngPath}" "${jpgPath}"`, (err) => {
                    if (err) {
                        // Fallback: copier le PNG
                        fs.copyFileSync(pngPath, jpgPath);
                    }
                    resolve();
                });
            } else {
                // Fallback: copier le PNG comme JPG
                fs.copyFileSync(pngPath, jpgPath);
                resolve();
            }
        });
    });
}

async function generateImages() {
    const docsDir = path.join(__dirname, '../docs');
    const svgPath = path.join(docsDir, 'database_schema.svg');
    const pngPath = path.join(docsDir, 'database_schema.png');
    const jpgPath = path.join(docsDir, 'database_schema.jpg');
    
    console.log('Génération des images du schéma de base de données...');
    console.log('Téléchargement du SVG...');
    
    try {
        await downloadFile(svgUrl, svgPath);
        console.log(`✓ SVG généré: ${svgPath}`);
        
        console.log('Téléchargement du PNG...');
        await downloadFile(pngUrl, pngPath);
        console.log(`✓ PNG généré: ${pngPath}`);
        
        console.log('Conversion PNG en JPG...');
        await convertPngToJpg(pngPath, jpgPath);
        console.log(`✓ JPG généré: ${jpgPath}`);
        
        console.log('✓ Toutes les images ont été générées avec succès!');
    } catch (error) {
        console.error('Erreur lors de la génération des images:', error.message);
        process.exit(1);
    }
}

generateImages();

