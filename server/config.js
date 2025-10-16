const fs = require('fs');
const path = require('path');

// Read OpenAI API key from gptkey.txt file
const getOpenAIKey = () => {
  try {
    const keyPath = path.join(__dirname, '../gptkey.txt');
    return fs.readFileSync(keyPath, 'utf8').trim();
  } catch (error) {
    console.error('Error reading OpenAI API key from gptkey.txt:', error);
    return null;
  }
};

// Get Google Cloud Vision credentials path
const getGoogleCredentialsPath = () => {
  // Check for GOOGLE_APPLICATION_CREDENTIALS environment variable first
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  
  // Otherwise, look for google-credentials.json in the root directory
  const credPath = path.join(__dirname, '../google-credentials.json');
  if (fs.existsSync(credPath)) {
    return credPath;
  }
  
  return null;
};

module.exports = {
  OPENAI_API_KEY: getOpenAIKey(),
  GOOGLE_CREDENTIALS_PATH: getGoogleCredentialsPath(),
  PORT: 3000
};
