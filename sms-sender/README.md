# Berlim Homes SMS sender (Mspace)

A Google Apps Script on the Berlim Homes Google account. Every minute it sends the texts the
ledger has queued in Firestore (`sms` collection) through Mspace, and marks each Sent or Failed.

The Mspace username, API key and sender ID live only in the script's **Script properties**,
never in the website.

Setup: see the comment at the top of `Code.gs`.
