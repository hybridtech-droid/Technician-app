require('dotenv').config();

const express = require('express');
const path = require('path');

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('.'));

app.get('/api/health', function (req, res) {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  res.json({ ok: true, keyLoaded: hasKey });
});

app.post('/api/diagnose', async function (req, res) {
  const { requestType, faultType, severity, onset, description, equipment, location } = req.body;

  if (!description || description.trim().length < 20) {
    return res.status(400).json({ error: 'Description too short.' });
  }

    const briefs = {
    fault: 'You are assisting a field service technician with a fault diagnosis. Give likely causes and the checks to run, in order.',
    installation: 'You are assisting a field service engineer with an equipment installation or commissioning. Give the checks and steps for this stage, and flag anything that must be verified before handover.',
    'after-sales': 'You are assisting with an after-sales support case on equipment already installed. Give likely causes, what to check, and whether this needs a site visit or can be resolved remotely.',
    application: 'You are assisting a field application specialist with an application or process concern. Assess the likely cause, suggest how to troubleshoot it, and recommend corrective actions including any contamination or process-control measures.'
  };

  const brief = briefs[requestType] || briefs.fault;

  let context =
    'Equipment: ' + equipment + '\n' +
    'Location: ' + location + '\n';

  if (requestType === 'fault') {
    context =
      context +
      'Fault category: ' + faultType + '\n' +
      'Severity: ' + severity + '\n' +
      'Onset: ' + onset + '\n';
  }

  const prompt =
    brief + '\n\n' +
    context +
    'Reported: ' + description + '\n\n' +
    'Keep it under 200 words. Write in plain prose with no Markdown formatting — no asterisks, hashes, or bullet symbols. ' +
    'Note any safety precautions first if they apply.';

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ diagnosis: message.content[0].text });
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: 'Diagnosis service unavailable.' });
  }
});

app.listen(PORT, function () {
  console.log('iTechAssist server running at http://localhost:' + PORT);
}); 