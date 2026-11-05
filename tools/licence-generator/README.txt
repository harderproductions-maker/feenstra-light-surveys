PRIMEOPS - PRIVATE ANNUAL LICENCE GENERATOR FOR WINDOWS

This tool runs separately from the app. It needs Node.js 22 LTS or newer
(https://nodejs.org). No npm install, paid service or internet connection is
needed after installing Node. Extract the ZIP before running it.

FIRST SETUP - DO THIS YOURSELF ON YOUR OWN WINDOWS PC
1. Double-click Generate-Licence.cmd and choose 1.
2. Choose a private folder, for example C:\PrimeOps-Owner.
   The tool creates licence-owner-private.pem and licence-owner-public.pem.
3. Keep the PRIVATE file ONLY on your own PC and an encrypted offline backup.
   Never upload it, email it, copy it to a server, or include it in a shared ZIP.
   Anyone holding it can generate tokens. Losing it prevents normal renewal.
4. Copy ONLY licence-owner-public.pem to the PrimeOps server.
   For Docker, put it in the server's licence-public folder, edit .env:
     LICENSE_PUBLIC_KEY_FILE=/data/licence/licence-owner-public.pem
   Then restart/recreate the app container:
     docker compose up -d --force-recreate app
   For direct Node hosting, set LICENSE_PUBLIC_KEY_FILE to the absolute public
   file path in the server environment and restart the Node service.
5. Open PrimeOps. Its activation screen displays a System ID. Copy that ID.
6. Run Generate-Licence.cmd again and choose 2. Supply your private key path,
   System ID and a NEW output filename. Leave previous-token file blank.
7. Open the saved token TXT file. Copy the full single line into the app's
   Activate / renew licence screen and activate while connected.
   No first token has been generated or activated on your behalf.

RENEW EACH YEAR
1. In Account > System licence / renewal, download the CURRENT token.
   This also works from the locked activation screen after expiry.
   Save it on your private PC. Keep the same original owner private key.
2. Run Generate-Licence.cmd, choose 2, and supply that current token file as
   the previous-token file. Choose a NEW filename for the generated token.
3. Paste the new token into PrimeOps and activate online. One activation
   renews the whole system. Other devices receive it when they next connect.
   Each device must reconnect before its cached token expires to work offline
   without interruption. A new token cannot be sent to a disconnected device.
4. Early renewal adds one calendar year from current expiry. If already
   expired, the new year starts when you generate the token. February 29
   expires on February 28 in a non-leap year.

COMMAND-LINE ALTERNATIVE (Command Prompt, from the extracted tool folder)
  node PrimeOps-Licence-Generator.cjs init "C:\PrimeOps-Owner"
  node PrimeOps-Licence-Generator.cjs issue "C:\PrimeOps-Owner\licence-owner-private.pem" SYSTEM-ID "C:\PrimeOps-Owner\first-token.txt"
  node PrimeOps-Licence-Generator.cjs issue "C:\PrimeOps-Owner\licence-owner-private.pem" SYSTEM-ID "C:\PrimeOps-Owner\renewal-token.txt" "C:\PrimeOps-Owner\current-token.txt"

BEHAVIOUR AND RECOVERY
- MMs and administrators see warnings in the open app one calendar month,
  seven days and one day before expiry. These are not background push alerts.
- All app accounts and ordinary API access lock at expiry, including cached
  offline sign-in. Saved work and queued uploads are retained, not deleted.
- Health checks, app updates and licence recovery remain available while locked.
- Only the owner's signed, system-bound tokens can activate or renew. Tokens
  do not replace user passwords and do not grant administrator permissions.
- Old tokens cannot roll back a server renewal. Keep the database backed up:
  the installation identity and current renewal chain are stored there.
- Correct device/server clocks if a backwards-clock warning appears, then
  reconnect. An active offline session also uses monotonic elapsed time.
- Offline enforcement assumes an unmodified app and protected device storage.
  It cannot be tamper-proof against someone who controls the device, changes
  the app code, edits storage, or restores an old database/device backup.
  Protect the server and use HTTPS. There is no remote private-key recovery.
