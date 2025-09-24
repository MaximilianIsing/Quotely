// Citation generator using MyBib website automation
async function generateCitation(url, style = 'APA') {
    try {
        let puppeteer;
        try {
            puppeteer = require('puppeteer');
        } catch (e) {
            throw new Error('Puppeteer not installed. Run: npm install puppeteer');
        }
        
        // Debug: Log environment info
        console.log('Puppeteer environment:', {
            PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH,
            PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR,
            NODE_ENV: process.env.NODE_ENV
        });

        const browser = await puppeteer.launch({ 
            headless: 'new',
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/render/.cache/puppeteer/chrome-linux64/chrome'
        });
        const page = await browser.newPage();
        
        // Set user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        
        // Navigate to MyBib APA citation generator
        await page.goto('https://www.mybib.com/tools/apa-citation-generator', { 
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        // Select citation style based on input
        if (style.toUpperCase() === 'APA') {
            const apaButton = await page.$('xpath//html/body/main/div/article/div/div/div[1]/div/div/div/div/div/div/div[1]/div[2]/button[2]');
            if (apaButton) {
                await page.evaluate(el => el.click(), apaButton);
            }
        } else if (style.toUpperCase() === 'MLA') {
            const mlaButton = await page.$('xpath//html/body/main/div/article/div/div/div[1]/div/div/div/div/div/div/div[1]/div[2]/button[7]');
            if (mlaButton) {
                await page.evaluate(el => el.click(), mlaButton);
            }
        }
        
        // Wait for the input field to be available using specific XPath
        await page.waitForSelector('xpath//html/body/main/div/article/div/div/div[1]/div/div/div/div/div/div/div[3]/input', { timeout: 10000 });
        
        // Clear and fill in the URL input field using specific XPath
        const inputElement = await page.$('xpath//html/body/main/div/article/div/div/div[1]/div/div/div/div/div/div/div[3]/input');
        await inputElement.click({ clickCount: 3 });
        await inputElement.type(url);

        // Click the search button using specific XPath
        const searchButton = await page.$('xpath//html/body/main/div/article/div/div/div[1]/div/div/div/div/div/div/div[3]/button');
        if (searchButton) {
            await searchButton.click();

        } else {
            // Try pressing Enter key as fallback
            await page.keyboard.press('Enter');

        }
        
        // Wait for results to load using specific XPath
        await page.waitForSelector('xpath//html/body/main/div/article/div/div/div[1]/div/div/div/div/div/div[2]/div/ul/li/button', { timeout: 15000 });

        
        // Click on the first result using specific XPath
        const firstResult = await page.$('xpath//html/body/main/div/article/div/div/div[1]/div/div/div/div/div/div[2]/div/ul/li/button');
        if (firstResult) {
            await firstResult.click();
        } else {
            throw new Error('First result not found');
        }
        
        // Wait for the copy button to appear using specific XPath
        await page.waitForSelector('xpath//html/body/main/div/article/div/div/div[1]/div/div/div/div/div/div/div/div[4]/button[1]/span/div', { timeout: 10000 });

        
        // Click the copy to clipboard button using specific XPath
        const copyButton = await page.$('xpath//html/body/main/div/article/div/div/div[1]/div/div/div/div/div/div/div/div[4]/button[1]/span/div');
        if (copyButton) {
            await copyButton.click();

        } else {
            throw new Error('Copy button not found');
        }
        
        // Get the citation from clipboard or from the page
        let fullCitation;
        try {
            // Wait a moment for the copy operation to complete
            await page.waitForTimeout(1000);
            
            // Try to get from clipboard using page.evaluate
            fullCitation = await page.evaluate(async () => {
                try {
                    const text = await navigator.clipboard.readText();
                    return text;
                } catch (e) {
                    return null;
                }
            });
            
            if (!fullCitation) {
                throw new Error('Clipboard is empty');
            }
        } catch (e) {
            
            // Try multiple selectors to find the citation on the page
            const citationSelectors = [
                'div[style*="background: rgb(254, 241, 196)"] p',
                'div[style*="background-color: rgb(254, 241, 196)"] p',
                '.citation-result p',
                '[class*="citation"] p',
                '[class*="formatted"] p',
                'div[class*="result"] p',
                'div[class*="output"] p'
            ];
            
            let citationFound = false;
            for (const selector of citationSelectors) {
                try {
                    const citationElement = await page.$(selector);
                    if (citationElement) {
                        fullCitation = await page.evaluate(el => el.textContent, citationElement);
                        citationFound = true;
                        break;
                    }
                } catch (selectorError) {
                    console.log(`Selector ${selector} failed:`, selectorError.message);
                }
            }
            
            if (!citationFound) {
                // Last resort: get all text content and search for citation pattern
                const pageContent = await page.evaluate(() => document.body.innerText);
                const citationMatch = pageContent.match(/([A-Za-z]+,\s*[A-Z].*?\.\s*[A-Za-z\s]+\.\s*https?:\/\/[^\s]+)/);
                if (citationMatch) {
                    fullCitation = citationMatch[1];
                } else {
                    throw new Error('Could not extract citation from page or clipboard');
                }
            }
        }
        
        // Get in-text citation from specific XPath
        let inText;
        try {
            const inTextElement = await page.$('xpath//html/body/main/div/article/div/div/div[1]/div/div/div/div/div/div/div/div[3]/span');
            if (inTextElement) {
                inText = await page.evaluate(el => el.textContent, inTextElement);
            } else {
                throw new Error('In-text citation element not found');
            }
        } catch (e) {
            console.log('Could not get in-text citation from XPath, generating from full citation...');
            // Fallback: extract from full citation
            const authorMatch = fullCitation.match(/^([^,]+),/);
            const authorLastName = authorMatch ? authorMatch[1].split(' ').pop() : 'Unknown';
            const yearMatch = fullCitation.match(/\((\d{4})\)/);
            const year = yearMatch ? yearMatch[1] : new Date().getFullYear();
            inText = `(${authorLastName}, ${year})`;
        }
        
        await browser.close();
        
        const citation = {
            inText: inText,
            fullCitation: fullCitation
        };
        
        return citation;
        
    } catch (error) {
        console.error('Error generating citation:', error.message);
        throw error;
    }
}

module.exports = { generateCitation };