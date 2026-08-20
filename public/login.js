const form = document.querySelector('#login-form');
const errorBox = document.querySelector('#login-error');
const passwordInput = form.elements.password;
const toggle = document.querySelector('#toggle-password');

function icons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

toggle.addEventListener('click', () => {
  const visible = passwordInput.type === 'text';
  passwordInput.type = visible ? 'password' : 'text';
  toggle.title = visible ? '显示密码' : '隐藏密码';
  toggle.innerHTML = `<i data-lucide="${visible ? 'eye' : 'eye-off'}"></i>`;
  icons();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const values = Object.fromEntries(new FormData(form));
  button.disabled = true;
  errorBox.textContent = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || '登录失败');
    location.replace('/');
  } catch (error) {
    errorBox.textContent = error.message;
    passwordInput.select();
  } finally {
    button.disabled = false;
  }
});

fetch('/api/auth/session').then((response) => {
  if (response.ok) location.replace('/');
}).catch(() => {});

icons();
