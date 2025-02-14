// Add this file to scan for IMDB links on the page
function addVidsrcButton(link) {
  if (link.vidsrcButton) return; // Skip if button already added
  
  const imdbId = link.href.match(/\/title\/(tt\d+)/)?.[1];
  if (!imdbId) return;

  const button = document.createElement('a');
  button.textContent = '▶ Watch';
  button.style.cssText = `
    margin-left: 5px;
    padding: 2px 6px;
    background: #f50;
    color: white;
    border-radius: 3px;
    font-size: 12px;
    text-decoration: none;
  `;
  button.href = `https://vidsrc.icu/embed/movie/${imdbId}`;
  button.target = '_blank';
  
  link.parentNode.insertBefore(button, link.nextSibling);
  link.vidsrcButton = true;
}

// Scan for IMDB links on page load
document.querySelectorAll('a[href*="imdb.com/title/"]').forEach(addVidsrcButton);

// Watch for dynamically added links
const observer = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === 1) { // Element node
          if (node.matches('a[href*="imdb.com/title/"]')) {
            addVidsrcButton(node);
          }
          node.querySelectorAll('a[href*="imdb.com/title/"]').forEach(addVidsrcButton);
        }
      });
    }
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true
}); 