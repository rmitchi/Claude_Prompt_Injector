# Claude Prompt Runner — Chrome Extension

A Chrome extension that automates sending your V5 Competitor Intelligence prompt to Claude AI, one country/region at a time.

## Why This Exists

Claude on claude.ai can **natively generate Excel files** with full formatting — something the API cannot do. This extension lets you leverage that capability while automating the repetitive part (sending the same prompt for each country with the geography swapped).

## Installation

1. Unzip `claude-prompt-injector.zip`
2. Open Chrome → go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `claude-prompt-injector` folder
6. The "CR" icon appears in your extensions bar

## First-Time Setup

### 1. Save Your Prompt
- Click the CR extension icon
- Go to the **Prompt Template** tab
- Paste your full V5 master prompt
- **Important**: Replace the geography in Part G's "DEFAULT GEOGRAPHIC SCOPE" with `{{VARIABLE}}`
  
  Instead of:
  ```
  PRIMARY: Gujarat state, India
  SUB-SCOPE: Palanpur, Ahmedabad, GIFT City / Gandhinagar, Surat, Rajkot
  ```
  
  Use:
  ```
  PRIMARY: {{VARIABLE}}
  SUB-SCOPE: Major cities and business hubs within {{VARIABLE}}
  ```

- The prompt auto-saves, or click "Save Prompt"
- You only need to do this once — it persists across sessions

### 2. Configure Settings (optional)
- **Delay between prompts**: 5 seconds (default). Increase if hitting rate limits.
- **Response timeout**: 600 seconds (default). The V5 prompt with web search can take 3-5 minutes.

## Usage

1. Open **claude.ai** and start a new conversation
2. Click the **CR** extension icon
3. In the **Run** tab, enter your countries (one per line):
   ```
   Gujarat, India
   Karnataka, India
   Maharashtra, India
   United Kingdom
   ```
4. Click **▶ Start Sending Prompts**
5. Watch it work — the extension will:
   - Inject the prompt with Country #1's geography
   - Click Send
   - Wait for Claude to finish (you'll see the response + Excel file appear)
   - Wait 5 seconds (default; configurable in Settings)
   - Send the next country
6. **Download each Excel manually** as it appears in the chat
7. When all countries are done, you'll see "All X countries complete!"

## How It Works

```
For each country in the list:
  1. Take your saved prompt
  2. Replace all {{VARIABLE}} with the current country
  3. Inject the text into Claude's chat input
  4. Click the Send button
  5. Wait for Claude to finish generating (watches for stop button)
  6. Wait the configured delay
  7. Repeat for next country
```

## Important Notes

- **Same conversation**: All countries are sent in one chat thread. This is simpler but means Claude might reference previous responses.
- **Manual downloads**: The extension only automates prompting — you download the Excel files yourself.
- **Rate limits**: Claude Pro has message limits. With web search + large prompts, expect ~10-15 messages before limits kick in. A longer delay in Settings helps pace this.
- **Fragility warning**: This extension interacts with Claude.ai's DOM, which Anthropic can change at any time. If the extension stops working after a Claude UI update, the selectors in `content.js` may need updating.
- **Keep the tab visible**: Chrome may throttle background tabs, which can interfere with response detection.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Could not find Claude's input field" | Make sure you're on a claude.ai chat page (not the home/project page) |
| "Could not find send button" | Claude UI may have updated — check `content.js` selectors |
| Prompt appears garbled | ProseMirror editor can be finicky — try refreshing claude.ai and retrying |
| Extension sends but Claude doesn't respond | Check if you've hit the Pro rate limit — wait and retry |
| Countries skip too fast | Increase the delay in Settings |
| Timeout on every country | Increase timeout in Settings (V5 + web search takes 3-5 min) |

## File Structure

```
claude-prompt-injector/
├── manifest.json       # Extension config
├── popup.html          # Extension popup UI
├── popup.js            # Popup logic (tabs, settings, run control)
├── content.js          # Core: DOM interaction with claude.ai
├── icons/              # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md           # This file
```

## Updating Selectors (When Claude UI Changes)

If the extension breaks after a Claude UI update, open `content.js` and update these:

1. **Editor selectors** (~line 90): `editorSelectors` array — the `contenteditable` div where you type
2. **Send button selectors** (~line 155): `buttonSelectors` array — the send/submit button
3. **Stop button selectors** (~line 225): `stopSelectors` array — the button that appears while Claude is generating

Use Chrome DevTools (F12) on claude.ai to inspect the current elements and find the right selectors.
