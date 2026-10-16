# Google Sheets lead mirror (per company)

Each company can keep a live copy of **its own** leads in **its own** Google Sheet (tab `Leads`). There is nothing to
configure on the server: the company owner connects the sheet in **Lead integrations → Google Sheet**.

Columns are the same as the lead export: `Source | Name | Phone | Email | Address | Received | Status | Assigned to`,
then the company's own lead-form fields, then "Other answers" from Meta / Google forms. Newest first, India time.

## How a company connects

1. Open the sheet (or make one at sheets.new).
2. **Extensions → Apps Script**, replace everything with the script shown in the CRM (it already contains the
   company's private key), save.
3. **Deploy → New deployment → Web app**, *Execute as: Me*, *Who has access: Anyone*, Deploy, authorise.
4. Paste the **Web app URL** (`https://script.google.com/macros/s/…/exec`) into the CRM and click **Connect**.
   The CRM writes the leads straight away to check it works, and only saves the address if it does.

## How it works

```
A company's lead is added / edited / assigned / changes status
        │  (waits ~4 s so a bulk import sends one update, not hundreds)
        ▼
Backend POSTs that company's full lead list + its secret ──► the Apps Script web app in that company's sheet
                                                              │ checks the secret
                                                              ▼
                                                              rewrites the "Leads" tab
```

- Every company has its own secret (stored encrypted, `SheetIntegration` model) and its own web-app address. A
  company's leads are only ever sent to its own address. Only Apps Script web-app addresses are accepted.
- Cells that a spreadsheet would run as formulas are written as plain text.
- The whole tab is rewritten each time, so edits and deletions show up too. Notes typed into `Leads` are overwritten —
  keep them on another tab. Up to 50,000 leads.
- If an update fails (script removed, deployment not shared with "Anyone", old key) the CRM shows the reason on the
  Google Sheet tab. **Make a new key** invalidates the old script; paste the new one and deploy a new version.

Code: `leads-integration/services/googleSheetSync.js`, `controllers/sheetController.js`, `utils/leadRows.js`,
script template `apps-script/CompanyLeadsSheet.gs`.
