# RegiVersj

RegiVersj er en enkel webapp for wobblere og fangster. Appen har ingen database og ingen server. Data lagres lokalt i nettleseren på enheten som brukes.

## Publisering på Vercel

1. Gå til [vercel.com](https://vercel.com) og logg inn.
2. Velg **Add New...** og deretter **Project**.
3. Importer prosjektet fra GitHub. Hvis du ikke har GitHub-prosjekt ennå, opprett et nytt repository på GitHub og last opp filene i denne mappen.
4. Når Vercel spør om innstillinger:
   - **Framework Preset:** Other
   - **Build Command:** la stå tom
   - **Output Directory:** la stå tom
5. Trykk **Deploy**.
6. Når publiseringen er ferdig, får du en nettadresse fra Vercel. Den kan åpnes på mobil og PC.

## Viktig om lagring

Appen bruker lokal lagring i nettleseren. Det betyr:

- Data du legger inn på mobilen lagres på den mobilen.
- Data du legger inn på PC lagres på den PC-en.
- Data deles ikke automatisk mellom personer eller enheter.
- Hvis nettleserdata slettes, kan også appdata bli slettet.
- Dette er bevisst nå, siden appen ikke skal ha database eller sikker innlogging ennå.

## Viktige filer

- `index.html` er startsiden Vercel åpner først.
- `outputs/fiskeredskap-register-prototype.html` er selve appen.
- `outputs/vergetjern-kart.png` er kartbildet som brukes i fangstregistreringen.
- `outputs/icon.svg` er logoikonet.
- `vercel.json` er en liten Vercel-innstilling for statisk publisering.
- `.vercelignore` forteller Vercel hvilke lokale arbeidsfiler som ikke trenger å publiseres.

## Lokal testing

Du kan åpne `index.html` direkte i nettleseren, eller starte en enkel lokal server og åpne prosjektmappen derfra. Appen trenger ingen bygging før publisering.
