// Function to extract IMDB ID from URL
function extractImdbId(url) {
  const match = url.match(/\/title\/(tt\d+)/);
  return match ? match[1] : null;
}

// Create context menu when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "openInVidsrc",
    title: "Open in Vidsrc",
    contexts: ["link"],
    targetUrlPatterns: ["*://*.imdb.com/title/*"]
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "openInVidsrc") {
    const imdbId = extractImdbId(info.linkUrl);
    if (imdbId) {
      const vidsrcUrl = `https://vidsrc.icu/embed/movie/${imdbId}`;
      chrome.tabs.create({ url: vidsrcUrl });
    }
  }
}); 