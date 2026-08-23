require('dotenv').config();

const express = require('express');
const path = require('path');

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb'}));
app.use(express.static('.'));

app.get('/api/health', function (req, res) {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  res.json({ ok: true, keyLoaded: hasKey });
});

app.post('/api/diagnose', async function (req, res) {
    const {
    requestType,
    faultType,
    severity,
    onset,
    description,
    equipment,
    location,
    installStage,
    equipmentModel,
    timeSinceInstall,
    warrantyStatus,
    applicationImpact,
    recurring,
    photo
  } = req.body;

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

  const photoNote = photo && photo.data
    ? '\n\nA photo of the equipment is attached. Describe what you can see in it that is relevant, and use it in your assessment.'
    : '';

  let context =
    'Equipment: ' + equipment + '\n' +
    'Location: ' + location + '\n';

  if (requestType === 'fault') {
    context = context +
      'Fault category: ' + faultType + '\n' +
      'Severity: ' + severity + '\n' +
      'Onset: ' + onset + '\n';
  }

  if (requestType ==='installation') {
    context = context +
      'Installation stage: ' + installStage + '\n' +
      'Make and model: ' + equipmentModel + '\n';
  }

  if (requestType === 'after-sales') {
    context = context +
      'Time since installation: ' + timeSinceInstall + '\n' +
      'Warranty status: ' + warrantyStatus + '\n';
  }

  if (requestType === 'application') {
    context = context +
      'Affected area: ' + applicationImpact + '\n' +
      'Recurrence: ' + recurring + '\n';
  }

  const prompt =
    brief + '\n\n' +
    context +
    'Reported: ' + description + '\n\n' +
    'Keep it under 200 words. Write in plain prose with no Markdown formatting — no asterisks, hashes, or bullet symbols. ' +
    'Note any safety precautions first if they apply.' + photoNote;

  try {
    let content = [];

    if (photo && photo.data) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: photo.mediaType,
          data: photo.data
        }
      });
    }

    content.push({ type: 'text', text: prompt });
    
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: content }]
    });

    res.json({ diagnosis: message.content[0].text });
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: 'Diagnosis service unavailable.' });
  }
});

app.post('/api/chat', async function (req, res) {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided.' });
  }

  const systemPrompt =
    'You are iTechAssist, assisting field service engineers, technicians and application specialists ' +
    'across engineering and non-engineering fields. Answer practically and concisely. ' +
    'Ask a clarifying question if the request is ambiguous. Note safety precautions where they apply. ' +
    'Write in plain prose with no Markdown formatting. Keep answers under 250 words unless more detail is clearly needed.';

  try {
    const reply = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 700,
      system: systemPrompt,
      messages: messages
    });

    res.json({ reply: reply.content[0].text });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat service unavailable.' });
  }
});

app.listen(PORT, function () {
  console.log('iTechAssist server running at http://localhost:' + PORT);
}); 