# Connecting Tervexa to WhatsApp

This explains what was built and the exact steps to get real WhatsApp messages flowing to your server. Everything below has already been tested against simulated messages — this guide is about connecting it to the real Meta WhatsApp Cloud API and, eventually, your live server.

## What this does

Once connected, any technician whose phone number is on their Tervexa account can message your WhatsApp number and:

- Ask a diagnostic question in plain language — answered by the same AI that powers "Ask AI" on the web app.
- Reply "report" to file a new fault report through a short guided conversation (equipment, location, description, optional photo) — this runs the same diagnosis logic as the web report form and saves to the same fault log.
- Reply "status" to see their open reports, or "status F-001" for one specific report.

Everything created or discussed over WhatsApp shows up in the web app too — a fault reported by WhatsApp appears in the fault log, and a WhatsApp conversation appears in "Ask AI" (tagged "WhatsApp" so it's clear where it came from). It is genuinely one account, two ways in — not a separate parallel system.

If someone messages from a phone number that isn't on any account, they're told to sign up on the web app first, using that exact number.

## Step 1: Create a Meta Developer app

1. Go to [developers.facebook.com](https://developers.facebook.com) and log in (or create an account) with a Facebook account.
2. Click **My Apps** → **Create App**.
3. Enter an app name and contact email, then for the use case pick **"Connect with customers through WhatsApp"** (Meta now routes app creation by use case rather than a generic "Business" app type).
4. Select an existing business portfolio, or let Meta create one for you.
5. Review the publishing requirements shown and confirm — this lands you on the WhatsApp **Quickstart** page for your new app.

## Step 2: Get your test number and credentials

Meta gives every new WhatsApp app a free test phone number automatically — no business verification needed yet.

1. On the Quickstart page, click **Start using the API**.
2. Connect to an existing WhatsApp Business Account, or let Meta create one for you. Note the **WhatsApp Business Account ID** it shows you.
3. Click **Generate access token** — this is your **Temporary access token** (it expires quickly, within a day or so; fine for testing today, but you'll regenerate it often until you set up a permanent one in the "known limitations" section below).
4. In the **From** phone number dropdown, select the free test number Meta assigned you — note the **Phone number ID** shown next to it.
5. Under **To**, add your own personal WhatsApp number as a test recipient (you'll need to verify it with a code sent to that number). You can add up to 5 test numbers this way — enough to test with your whole team before going live.
6. Click **Send message** to confirm the test number can actually reach your phone before moving on.

Copy the access token and phone number ID — you'll need them in Step 4.

## Step 3: Add the environment variables

In your project's `.env` file, add:

```
WHATSAPP_TOKEN=<the temporary access token from Step 2>
WHATSAPP_PHONE_NUMBER_ID=<the phone number ID from Step 2>
WHATSAPP_VERIFY_TOKEN=<make up any random string yourself, e.g. tervexa-verify-8k2j>
```

`WHATSAPP_VERIFY_TOKEN` isn't given to you by Meta — you invent it, and enter the exact same value in Meta's dashboard in Step 5. It's just a shared password so Meta can prove it's really Meta calling your webhook.

Restart `node server.js` after adding these so it picks them up.

## Step 4: Expose your local server to the internet (for testing only)

Meta needs a real public HTTPS URL to send messages to — it can't reach `localhost`. Until Tervexa is deployed for real, use a free tunnel tool to test:

1. Install [ngrok](https://ngrok.com/download) (free account is enough) or use `npx localtunnel`.
2. With your server running (`node server.js`, listening on port 3000), in another terminal run:
   ```
   ngrok http 3000
   ```
3. ngrok prints a public URL like `https://a1b2-c3d4.ngrok-free.app`. That's your temporary public address — anything sent there reaches your local server.

This URL changes every time you restart ngrok on the free plan, so you'll re-do Step 5 each time you restart it during testing. Once Tervexa is deployed to a real domain, you'll use that domain instead and never need ngrok again.

## Step 5: Configure the webhook in Meta

1. Back in the WhatsApp product page in Meta's dashboard, find **Configuration** → **Webhook**.
2. Click **Edit**, and enter:
   - **Callback URL**: your ngrok URL (or later, your real domain) followed by `/webhook/whatsapp` — e.g. `https://a1b2-c3d4.ngrok-free.app/webhook/whatsapp`
   - **Verify token**: the exact same string you put in `WHATSAPP_VERIFY_TOKEN`
3. Click **Verify and save**. If your server is running and the token matches, this succeeds immediately — Meta just made the GET request your server already knows how to answer.
4. Below that, under **Webhook fields**, click **Manage** and subscribe to **messages**. This is what tells Meta to actually forward incoming messages to your URL, not just the verification check.

## Step 6: Test it

From the phone number you added as a test recipient in Step 2, send a WhatsApp message to the test number shown in Meta's dashboard. Try:

- A plain question like "What causes a compressor to short-cycle?"
- "report" to walk through filing a fault
- "status" once you have at least one report

Watch your server's terminal — every step logs what's happening. If `WHATSAPP_TOKEN` isn't set yet, outgoing replies get logged to the console instead of actually sent, so you can build and test the logic itself before your Meta credentials are ready.

## Known limitations, honestly

- **Temporary access token**: the token from Step 2 expires quickly (within about a day) during testing. Before relying on this for real use, generate a permanent token via a Meta **System User**: in your Business Settings, go to **Users → System Users**, create one (or use an existing one), click **Add Assets** and grant it your app (with Manage permission) and your WhatsApp Business Account, then click **Generate New Token** on that system user, select your app, and check the `whatsapp_business_messaging` and `whatsapp_business_management` permissions. That token doesn't expire the way the quickstart one does — use it in place of the temporary one in your `.env`.
- **Production numbers**: messaging real users beyond your 5 test numbers requires Meta's business verification process for your WhatsApp Business Account, which can take anywhere from a day to a couple of weeks. Start that process early if you want WhatsApp live around the same time as deployment.
- **Deployment dependency**: the tunnel in Step 4 is for testing only. Once Tervexa has a real server and domain, point the webhook at that instead and this becomes fully production-ready with no code changes needed.
