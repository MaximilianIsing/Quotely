module.exports = {
  "broad": [
    "- Find quotes that are related to the topic and surrounding themes",
    "- Include quotes that touch on related concepts or themes",
    "- Include quotes that are contextually relevant even if they don't explicitly mention the topic",
    "- Be generally inclusive - cast a wider net for relevant quotes"
  ].join('\n    '),

  "balanced": [
    "- Find quotes that are SPECIFIC to the topic provided by the user",
    "- Select quotes that DIRECTLY mention or discuss the topic keywords",
    "- Include contextually related quotes ONLY if they provide critical background that enhances understanding of the topic",
    "- Exclude quotes that do not explicitly mention the topic or are only tangentially related",
    "- Do NOT include general quotes about the broader subject area unless they specifically address the exact topic",
  ].join('\n    '),

  "precise": [
    "- Find quotes that are HIGHLY SPECIFIC to the topic provided by the user",
    "- ONLY select quotes that DIRECTLY mention or discuss the EXACT topic keywords provided",
    "- EXCLUDE ANY quotes that do not explicitly mention the topic or are only tangentially related",
    "- Do NOT include general quotes about the broader subject area unless they specifically use the EXACT topic keywords",
    "- Do NOT include quotes that are merely contextually related without directly addressing the topic",
    "- Do NOT include contextual background - ONLY quotes that directly address the topic",
  ].join('\n    ')
};
