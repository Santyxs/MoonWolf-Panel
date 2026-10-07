async function ensureCodeMirror(mode) {
  if (window.CodeMirror) return true;
  const base = 'https://cdn.jsdelivr.net/npm/codemirror@5.65.2';

  if (!codeMirrorPromise) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${base}/lib/codemirror.min.css`;
    document.head.appendChild(css);

    const theme = document.createElement('link');
    theme.rel = 'stylesheet';
    theme.href = `${base}/theme/dracula.min.css`;
    document.head.appendChild(theme);

    codeMirrorPromise = loadExternalScript(`${base}/lib/codemirror.min.js`);
  }

  try {
    await codeMirrorPromise;
    const modeUrl = {
      javascript: `${base}/mode/javascript/javascript.min.js`,
      yaml: `${base}/mode/yaml/yaml.min.js`,
      xml: `${base}/mode/xml/xml.min.js`,
      properties: `${base}/mode/properties/properties.min.js`,
      shell: `${base}/mode/shell/shell.min.js`,
      toml: `${base}/mode/toml/toml.min.js`,
      nginx: `${base}/mode/nginx/nginx.min.js`,
    }[mode];

    if (modeUrl && !document.querySelector(`script[data-codemirror-mode="${mode}"]`)) {
      await loadExternalScript(modeUrl);
      document.querySelectorAll('script').forEach(script => {
        if (script.src === modeUrl) script.dataset.codemirrorMode = mode;
      });
    }

    return true;
  } catch {
    return false;
  }
}
