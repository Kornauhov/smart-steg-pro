# Smart Steg PRO (modularisiert)

## Start
```bash
npm install
npm run dev
```

## Struktur (Kurz)
- `src/App.jsx` – Hauptlogik (1:1 aus deiner Version, aber ohne Inline-Firebase-Init und ohne Inline-UI-Komponenten)
- `src/firebase/*` – Firebase Init + Doc-Refs
- `src/components/*` – wiederverwendbare UI-Teile (Icon/Segmented/StatChip/NavBtn)
- `src/utils/*` – Helper (IDs/Parsing)
- `src/config/*` – Konstante Werte + Firebase Config
