PRIMEOPS SERVER (front end + back end) - Windows PC

1. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) and start it.
2. Double-click start-server.bat. On first run choose the admin username and password.
   The first start builds the app and can take several minutes.
3. Open PrimeOps Owner on Windows, connect to http://localhost:3001, and register
   your separate owner login using the initial client administrator credentials.
   Generate the first annual token for the selected client. Then open PrimeOps,
   enter that client's company code and sign in. See owner-app/README.txt.
   New companies can be registered and managed from the owner desktop app.
4. Phone: install PrimeOps.apk, open it, expand "Server address" on the sign-in screen and
   enter http://<this PC's IP>:3001 (start-server.bat prints it). The phone must be on the same Wi-Fi.
5. Desktop app: File > Server address... and enter the same address.

Where completed checklists/reports are saved
- Reports are saved on this PC under the "reports" folder next to start-server.bat, as
  Building / Report type / date.
- Admins choose or create the sub-folder in the app: Report storage tab.
- To use another drive or folder, edit .env and set REPORTS_DIR, for example
  REPORTS_DIR=D:/PrimeOps Reports
  then run stop-server.bat and start-server.bat.

Accounts
- Students and maintenance assistants can only use Maintenance tickets and their account.
- The admin password is whatever is in .env (ADMIN_PASSWORD); edit it and restart to reset it.

Back up the database using your configured PostgreSQL user/database:
  docker compose exec database sh -c "pg_dump -U $POSTGRES_USER $POSTGRES_DB" > backup.sql
Also back up .env (especially JWT_SECRET), reports and company-reports.
The owner's signing key is encrypted on the server and needs the unchanged
JWT_SECRET to be recovered. Keep these backups private and encrypted.
Stop the server: stop-server.bat

UPDATING AN EXISTING SERVER
- Keep the same Docker project name/directory, volumes, .env/JWT_SECRET and reports.
- Do not delete the database or re-register the existing customer.
- The first client retains its existing usernames, passwords and checklists.
- New clients choose their own features; owner approvals are in the Windows app.
- See README.md for the Android migration APK and encrypted device backup.
