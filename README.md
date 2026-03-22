# Trade Dash

Options trading pipeline: data → strategies → optimizer → backtest → vault → trading (paper / live).

## Run frontend + backend together

From the repo root (after `backend/venv` exists and deps are installed):

```bash
npm install
npm run dev:all
```

- **Web:** http://localhost:3000  
- **API:** http://127.0.0.1:8000 (docs at `/docs`)

This runs Next.js and FastAPI in one terminal with colored labels (`web` / `api`).

### Backend env

Put Kite credentials in `backend/.env` or `backend/.env.local` (`.env.local` overrides `.env`).

### Run them separately (optional)

**Terminal 1 — API**

```bash
cd backend
# Windows:
.\venv\Scripts\activate
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

**Terminal 2 — UI**

```bash
npm run dev
```

### Point the UI at another API URL

Create `.env.local` in the **project root** (Next.js):

```env
NEXT_PUBLIC_API_URL=http://127.0.0.1:8000
```
