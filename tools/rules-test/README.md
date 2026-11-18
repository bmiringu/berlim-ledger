# Security rules check

Checks `firestore.rules` against a local Firestore emulator (nothing touches the live database).

In Cloud Shell:

    cd ~/berlim-ledger/tools/rules-test && npm i --silent && cp ../../firestore.rules . && firebase emulators:exec --only firestore --project demo-berlim "node test.mjs"

Every line should start with PASS.
