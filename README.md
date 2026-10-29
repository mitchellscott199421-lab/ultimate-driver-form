# The Ultimate Driver 2027 – Section 2 Party Registration (prototype)
Run: `npm install && ADMIN_PASSWORD=choose-one node server.js` then open http://localhost:3000 (admin: /admin, any username + ADMIN_PASSWORD).
Config: config.json (group names + managerEmail, RQ email, upload limit). Env: PORT, ADMIN_PASSWORD, LINK_SECRET, PUBLIC_BASE_URL, DATA_DIR,
SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM. With no SMTP_HOST, emails are written to ./outbox/ only.
Data: private-data/<id>/{submission.json,id-document.*,signature.png} – never served statically; only via HMAC-tokened /files links or /admin.
