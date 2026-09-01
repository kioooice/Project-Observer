const scanBtn = document.querySelector('#scanBtn');
const rootInput = document.querySelector('#rootInput');

if (scanBtn && rootInput) {
  scanBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();

    const current = rootInput.value.trim();
    const next = window.prompt('扫描项目目录', current || 'D:\\Projects');
    if (next == null) return;

    const value = next.trim();
    if (value) rootInput.value = value;

    rootInput.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true
    }));
  }, true);
}
