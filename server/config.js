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

module.exports = {
  OPENAI_API_KEY: getOpenAIKey(),
  PORT: 3000
};
