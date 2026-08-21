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
  const { faultType, severity, onset, description, equipment, location } = req.body;

  if (!description || description.trim().length < 20) {
    return res.status(400).json({ error: 'Description too short.' });
  }

  const prompt =
    'You are assisting a field service technician. Give a concise diagnostic assessment.\n\n' +
    'Equipment: ' + equipment + '\n' +
    'Location: ' + location + '\n' +
    'Fault category: ' + faultType + '\n' +
    'Severity: ' + severity + '\n' +
    'Onset: ' + onset + '\n' +
    'Observed: ' + description + '\n\n' +
    'Respond with likely causes and the checks to run, in order. Keep it under 200 words. ' +
    'Note any safety precautions first if the severity warrants it.';

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