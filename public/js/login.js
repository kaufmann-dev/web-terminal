(async () => {
  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('error');
  const btn = document.getElementById('btn-submit');

  let csrfToken = '';
  try {
    const res = await fetch('/csrf-token');
    const data = await res.json();
    csrfToken = data.csrfToken || '';
  } catch (e) {
    errorEl.textContent = 'Unable to initialize login. Please refresh.';
    btn.disabled = true;
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    btn.disabled = true;

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ email, password }),
      });

      if (res.ok) {
        const data = await res.json();
        window.location.href = data.redirect || '/terminal';
        return;
      }

      const data = await res.json().catch(() => ({}));
      errorEl.textContent = data.error || 'Invalid email or password.';
    } catch (err) {
      errorEl.textContent = 'Network error. Please try again.';
    } finally {
      btn.disabled = false;
    }
  });
})();
