(async () => {
  const logoutBtn = document.getElementById('logout-btn');

  let csrfToken = '';
  try {
    const res = await fetch('/csrf-token');
    const data = await res.json();
    csrfToken = data.csrfToken || '';
  } catch (e) {
    // Non-critical; logout may fail without CSRF token
  }

  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try {
      const res = await fetch('/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': csrfToken,
        },
      });
      if (res.ok) {
        window.location.href = '/';
        return;
      }
    } catch (e) {
      // ignore
    }
    logoutBtn.disabled = false;
  });
})();
