const express = require('express');
const router = express.Router();
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

router.post('/', async (req, res) => {
  try {
    const { finding } = req.body;
    
    if (!finding) {
      return res.status(400).json({ error: 'No finding data provided.' });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OpenAI API anahtar\u0131 sunucuda tan\u0131ml\u0131 de\u011fil.' });
    }

    const systemPrompt = `You are a professional Malware & Cyber Security Analyst. You are given a finding from an anti-cheat memory scanner.
You must analyze the finding and return a concise, 2-3 sentence verdict on whether it is a cheat, false positive, or suspicious.
Reply completely in Turkish. Keep it professional.

Data:
Title: ${finding.title || 'Unknown'}
Module: ${finding.category || 'Unknown'}
Severity: ${finding.severity || 'Unknown'}
Evidence: ${finding.evidence || 'No evidence'}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "L\u00fctfen bu bulguyu analiz et." }
      ],
      temperature: 0.2,
      max_tokens: 150
    });

    const aiResponse = completion.choices[0].message.content.trim();

    return res.json({ success: true, ai_analysis: aiResponse });

  } catch (error) {
    console.error('OpenAI API Error:', error);
    res.status(500).json({ success: false, error: 'AI analizi s\u0131ras\u0131nda bir hata olu\u015ftu.' });
  }
});

module.exports = router;
