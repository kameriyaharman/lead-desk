# Lead Desk

WhatsApp leads ka auto-tracking dashboard. WhatsApp Business number ko linked device (QR) ki tarah jodta hai, **sirf messages padhta hai** (kabhi bhejta nahi), har chat ko lead banata hai, aur AI se requirement, budget, stage aur next follow-up nikalta hai.

## Environment variables
- `DASHBOARD_PASSWORD` — login password (zaroori)
- `DATA_DIR` — database aur WhatsApp login kahan save ho (Railway volume: `/data`)
- `ANTHROPIC_API_KEY` — AI chat understanding ke liye (optional, iske bina leads aur reply-pending tab bhi chalte hain)
- `AI_MODEL` — default `claude-haiku-4-5`
- `BUSINESS_CONTEXT` — aapka business ek line mein, AI ko samjhane ke liye
- `HISTORY_DAYS` — kitne din purani chats import karni hain (default 90)

## Chalana
`npm install && npm start`
