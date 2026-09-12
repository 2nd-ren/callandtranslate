# App ideas

Ideas for apps and features. Each app gets its own section. Keep apps, ideas, and to-dos separated.

---

## Call & translate agent (working title TBD)

**One-liner:** Voice agent that calls people in another language on your behalf, with live transcription, translation, and two-way interactivity over speakerphone.

### Concept

Start the app in voice mode. You set a task and pick the language the other person speaks (not necessarily yours). The agent places/handles the call and talks to them in their language, like xAI voice mode acting for you.

Typical use: you’re abroad or calling a company in another country and need something done — the agent does the call for you.

### How it works

- **Speakerphone setup:** Phone on speaker so you, the agent, and the other person can all hear each other. That shared audio also reduces the other side’s hesitation about “just talking to AI.”
- **Live transcription (WebSocket):** Continuous transcription of both sides during the conversation.
- **Live translation for you:** While the other person speaks, the agent transcribes and translates so you can *read* what’s being said in real time.
- **Interject in your language:** You can jump in in your own language; the agent translates for the other person and continues.
- **When they ask to talk to you:** They hear the agent speaking to you in your language; your reply is translated back for them. Everyone can hear everyone; everything stays transcribed.

### Key idea (biggest feature)

**Interactivity, not set-and-forget.** You stay in the loop: read live translations, interject anytime, and the agent mediates both ways. Not a one-shot “go do this call” black box.

### Ideas / notes

- [ ] Name the app
- [ ] Define call flow (outbound only vs inbound too)
- [ ] Clarify reporting output after the call (summary, transcript, action items)
- [ ] Confirm stack assumption: WebSocket for real-time transcription during the call
- [ ] UX for task setup + target language + your language
- [ ] Trust / disclosure copy for the other party (speakerphone + “AI assisting”)

### To-dos

- [ ] Capture a short product brief from this note
- [ ] Sketch happy-path call sequence (start → task → language → call → interject → end → report)

---
