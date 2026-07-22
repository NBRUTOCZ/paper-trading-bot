# Norbi Paper Trading Bot

GitHub Pages-re készített, böngészőben futó paper-trading dashboard.

## Mit tud?

- élő Binance USDⓈ-M futures 1 perces gyertyák;
- BTCUSDT, ETHUSDT, SOLUSDT és BNBUSDT piac;
- beállítható virtuális kezdőtőke;
- automatikus gyors/lassú EMA-kereszteződési stratégia;
- beállítható pozícióméret, stop-loss, take-profit és díj;
- élő realizált és nem realizált P&L;
- maximális drawdown, találati arány és tőkegörbe;
- kötésnapló és CSV export;
- böngészőben történő automatikus mentés `localStorage` segítségével.

## Fontos

Ez a projekt kizárólag szimulált kereskedésre szolgál. Nem kér API-kulcsot, és nem küld valódi tőzsdei megbízást.

A GitHub Pages statikus webhely. Valódi kereskedési API-kulcsot tilos a frontend JavaScriptbe tenni, mert a látogatók hozzáférhetnének. Valódi kereskedéshez külön, biztonságos backend, titkos kulcstárolás, hitelesítés és a szolgáltató szabályainak ellenőrzése szükséges.

## GitHub Pages telepítés

1. Hozz létre GitHubon egy új, például `paper-trading-bot` nevű repositoryt.
2. Töltsd fel az `index.html`, `styles.css` és `app.js` fájlokat a repository gyökerébe.
3. Nyisd meg a repository **Settings → Pages** részét.
4. A **Build and deployment** résznél válaszd a **Deploy from a branch** lehetőséget.
5. Branch: `main`, mappa: `/ (root)`, majd **Save**.
6. A GitHub rövidesen megjeleníti a nyilvános oldal címét.

## Helyi futtatás

A böngészők egy része korlátozhatja a `file://` módból indított hálózati kéréseket. Indíts egyszerű helyi szervert:

```bash
python -m http.server 8080
```

Ezután nyisd meg:

```text
http://localhost:8080
```

## Stratégia

A bot lezárt 1 perces gyertyán vizsgálja a gyors és lassú EMA kereszteződését.

- gyors EMA alulról keresztezi a lassút → LONG;
- gyors EMA felülről keresztezi a lassút → SHORT;
- stop-loss vagy take-profit érintésekor zár;
- ellentétes EMA-jelnél zárja és megfordítja a pozíciót.

A szimuláció nem tartalmaz order-book csúszást, finanszírozási díjat, likvidációt, tőkeáttételt vagy hálózati késleltetésből eredő végrehajtási eltérést.
