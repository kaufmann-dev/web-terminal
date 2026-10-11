'use strict';

const ERROR_COPY = {
  403: ['Access denied', "You don't have permission to view this page."],
  404: ['Page not found', "This page doesn't exist. It may have been moved, or the address has a typo."],
  500: ['Something went wrong', 'An unexpected error occurred. Try again in a moment.'],
};

function errorCopy(status) {
  if (ERROR_COPY[status]) {
    return ERROR_COPY[status];
  }
  return status >= 500 ? ERROR_COPY[500] : ['Request could not be completed', 'The request was invalid.'];
}

function renderErrorPage(status) {
  const [title, message] = errorCopy(status);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Terminal</title>
  <link rel="icon" href="/static/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/static/css/style.css">
</head>
<body class="dark">
  <main class="login-container">
    <div class="login-card">
      <p class="error-status">Error ${status}</p>
      <h1>${title}</h1>
      <p class="login-intro">${message}</p>
      <a class="btn-primary" href="/">Back to terminal</a>
    </div>
  </main>
</body>
</html>
`;
}

module.exports = { renderErrorPage };
