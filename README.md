# rt117-glue-lock

Lås upp RT117:s och RT36:s lokal i Linköping via hemsidan. Medlemmar loggar in med
Google eller en engångskod till e-posten, trycker på en knapp, och Glue-låset öppnas.
Admins sköter medlemslistan i ett webbgränssnitt, och den som inte är medlem kan
ansöka om åtkomst direkt på sidan.

## Status

| Del | Läge |
| --- | --- |
| Inloggning med Google (OAuth 2.0 + PKCE) | Klart, kräver OAuth-uppgifter |
| Inloggning med engångskod till e-post | Klart, kräver Resend-nyckel |
| Sessioner, återkallning, utloggning | Klart |
| Upplåsning mot Glue + statuspollning | Klart, kräver API-nyckel. Går i simulerat läge tills dess |
| Ansökningar: icke-medlemmar kan ansöka, admins godkänner | Klart |
| Datumbegränsad åtkomst (uthyrning) | Klart |
| Admin: lägg in, redigera, pausa, ta bort, ändra roll | Klart |
| Admin: importera medlemmar från urklipp | Klart |
| Revisionslogg (vem loggade in, vem låste upp) | Klart |
| Nödstopp som stänger av upplåsning | Klart |
| Hastighetsbegränsning och botskydd | Klart, Turnstile valfritt |
| SMS-koder | Ej byggt. `phone` finns i databasen så det går att lägga på |

48 tester passerar (`npm test`) och typkontrollen är grön.

### Vad som återstår innan det fungerar på riktigt

Allt nedan är konto- och konfigurationsarbete, ingen kodning. Deployen är
automatisk, det handlar om att mata in nycklar (se [Driftsättning](#driftsättning)):

1. Lägg in `CLOUDFLARE_API_TOKEN` och `CLOUDFLARE_ACCOUNT_ID` som GitHub-secrets.
   Därefter deployar varje push till `main` av sig själv.
2. Generera `SESSION_SECRET` och `OTP_PEPPER`, och sätt `BOOTSTRAP_ADMIN_EMAILS`
   till din adress så du blir admin.
3. Hämta en Glue-API-nyckel och peka ut rätt lås.
4. Skapa en Google OAuth-klient.
5. Verifiera avsändardomän hos Resend och lägg DNS-poster på `rt117.se`.
6. Lägg in resten av medlemmarna via adminsidan.
7. Låt någon titta på GDPR-frågan (se [Personuppgifter](#personuppgifter)).

## Så fungerar det

```
Medlemmens telefon
      │  https://lock.rt117.se
      ▼
Cloudflare Worker (Hono)  ──►  D1 (medlemmar, ansökningar, koder, logg)
      │
      │  Authorization: Api-Key …
      ▼
Glue Homes moln  ──►  Glue Hub i lokalen  ──(Bluetooth)──►  Låset
```

Det viktiga i den bilden: **upplåsningen går via Glues moln, inte via lokalen.**
Sidan ligger hos Cloudflare och behöver inget öppet nätverk i lokalen, men hubben
som sitter i lokalen måste ha internet för att kunna ta emot kommandot.

Glue-API:t vi anropar:

| Vad | Anrop |
| --- | --- |
| Skapa API-nyckel | `POST https://user-api.gluehome.com/v1/api-keys` (Basic auth) |
| Lista lås | `GET /v1/locks` |
| Låsa upp | `POST /v1/locks/{lockId}/operations` med `{"type":"unlock"}` |
| Läsa status | `GET /v1/locks/{lockId}/operations/{operationId}` |

Autentisering sker med `Authorization: Api-Key <nyckel>`. Kontraktet är verifierat
mot Glues officiella Python-klient (`gluehome` 0.1.2 på PyPI), inte gissat.

Upplåsningen är tvåstegs: `POST /api/unlock` skapar operationen och svarar direkt,
sedan pollar frontenden `GET /api/unlock/:id`. Det gör att inget anrop hänger medan
låset snurrar, vilket håller sig gott inom Workers gränser.

### Ansökningsflödet

Den som loggar in med en adress som inte finns i medlemslistan nekas inte längre.
I stället händer detta:

1. Personen verifierar sin e-postadress, med Google eller med en engångskod.
2. En kortlivad, signerad ansökningscookie utfärdas. Den ger bara tillgång till
   ansökningsformuläret, inget annat.
3. Personen fyller i namn, klubb (RT117, RT36, OT117, OT36, LC17, LC76, LC166,
   Gäst eller fritext via Annan) och ett valfritt meddelande.
4. Admins med mejlnotiser påslagna får ett mejl, och ansökan dyker upp på
   adminsidans flik Ansökningar.
5. Vid godkännande skapas medlemmen och personen får ett välkomstmejl. Vid avslag
   skickas ett neutralt besked. Varje admin kan stänga av ansökningsmejlen för
   egen del i redigeringsdialogen.

### Datumbegränsad åtkomst

Varje medlem kan ha ett startdatum och ett slutdatum, tänkt för uthyrning och
tillfälliga gäster. Utanför fönstret går det fortfarande att logga in, så att en
hyresgäst kan kontrollera att inloggningen fungerar i förväg, men
upplåsningsknappen är spärrad och servern nekar med ett tydligt meddelande.
Slutdatumet gäller hela dagen ut.

### Kodkarta

```
src/
  index.ts              Worker-ingång, felhantering, /api/me, nattlig städning
  types.ts              Env-bindningar och delade typer
  lib/                  crypto, normalisering, rate limiting, e-post, logg, inställningar
  auth/
    session.ts          Signerade cookies: session + ansökan (HMAC-SHA256)
    google.ts           OAuth 2.0 + PKCE
    otp.ts              Engångskoder
    middleware.ts       requireMember / requireAdmin / requireApplicant
  members/
    repo.ts             CRUD mot D1, giltighetsfönster
    source.ts           Uppslag vid inloggning + bootstrap-admin
  applications/repo.ts  Ansökningar: skapa, lista, avgöra
  glue/client.ts        Glue-klient + mock
  routes/               auth, apply, unlock, admin
web/                    React-frontend (Vite)
migrations/             D1-schema
scripts/                Glue-nyckel, låslista, hemligheter
```

## Kostnad

Allt ligger inom gratisnivåer. Kontrollera aktuella gränser hos leverantörerna,
de ändras då och då, men i grova drag:

- **Cloudflare Workers**: 100 000 anrop/dygn. En klubb med ett femtiotal medlemmar
  landar på några hundra.
- **Cloudflare D1**: gott och väl inom gratisnivån för den här datamängden.
- **Cloudflare Turnstile**: gratis.
- **Resend**: 100 mejl/dygn, 3 000/månad. Engångskoder och ansökningsnotiser för
  en klubb ligger långt under.

## Kom igång lokalt

```bash
npm install
cp .dev.vars.example .dev.vars
npm run secrets:gen          # klistra in värdena i .dev.vars
npm run db:migrate:local     # lokal SQLite, ingen Cloudflare-inloggning behövs
npm run dev                  # Vite på :5173, Worker på :8787
```

Öppna http://localhost:5173. Sätt din egen adress i `BOOTSTRAP_ADMIN_EMAILS` i
`.dev.vars` så läggs du in som admin första gången du loggar in.

Lokalt behövs ingen riktig D1-databas: `--local` använder en SQLite-fil, och
platshållaren för `database_id` i `wrangler.jsonc` duger. Den riktiga databasen
skapas automatiskt vid första deployen.

Utan `RESEND_API_KEY` skickas inga mejl. **Engångskoden skrivs i stället ut i
`wrangler dev`-loggen**, vilket är det bekväma sättet att testa lokalt. Utan
`GLUE_API_KEY` körs ett simulerat lås som beter sig som det riktiga.

```bash
npm test          # 48 tester
npm run typecheck
```

Testerna nollar alltid mejl-, Google- och Glue-nycklarna (se `vitest.config.ts`),
så de når aldrig riktiga tjänster även om `.dev.vars` har skarpa värden.

## Driftsättning

Deployen är automatisk: **push till `main` bygger, testar och deployar.**
Workflowen ligger i [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).
Pull requests kör bara testerna, inget deployas.

Varje körning gör detta i ordning:

1. Typkontroll och tester. Misslyckas de deployas ingenting
2. Skapar D1-databasen om den inte finns, och pekar konfigurationen på den
3. Kör databasmigrationer
4. Bygger frontenden och deployar Workern, inklusive domänkopplingen
5. Synkar hemligheterna från GitHub till Workern
6. Kontrollerar att sidan svarar (fäller inte deployen om DNS inte är klart)

Du behöver alltså aldrig köra `wrangler` lokalt. Databasens id slås upp vid
deploy, så det behöver inte checkas in.

### Steg 1: Ge GitHub tillgång till Cloudflare

Detta är det enda som måste göras utanför GitHub. I Cloudflare-dashboarden under
**My Profile → API Tokens → Create Token**: använd mallen **Edit Cloudflare
Workers** och lägg till behörigheten **Account → D1 → Edit**. Ditt konto-id står
på översiktssidan för kontot.

Lägg sedan in båda i GitHub under **Settings → Secrets and variables → Actions →
New repository secret**:

| Secret | Värde |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Token du just skapade |
| `CLOUDFLARE_ACCOUNT_ID` | Ditt Cloudflare-konto-id |

### Steg 2: Mata in nycklarna

Alla i samma GitHub-vy. Tomma eller saknade hoppas över, så du kan lägga till
dem en och en. Inget raderas för att det inte är ifyllt ännu.

| Secret | Krävs | Var du får det |
| --- | --- | --- |
| `SESSION_SECRET` | **Ja** | `npm run secrets:gen` |
| `OTP_PEPPER` | **Ja** | `npm run secrets:gen` |
| `BOOTSTRAP_ADMIN_EMAILS` | **Ja, till att börja med** | Din egen adress. Flera går att komma, kommaseparerat |
| `RESEND_API_KEY` | För engångskoder och ansökningsmejl | [resend.com](https://resend.com) → API Keys |
| `GOOGLE_CLIENT_ID` | För Google-inloggning | Google Cloud Console (se nedan) |
| `GOOGLE_CLIENT_SECRET` | För Google-inloggning | Samma ställe |
| `GLUE_API_KEY` | För att öppna på riktigt | `npm run glue:api-key` |
| `GLUE_LOCK_ID` | Bara om ni har flera lås | `npm run glue:locks` |
| `TURNSTILE_SITE_KEY` | Nej | Cloudflare → Turnstile |
| `TURNSTILE_SECRET_KEY` | Nej | Samma ställe |

Utan `SESSION_SECRET` och `OTP_PEPPER` avbryts deployen med ett tydligt fel,
ingen skulle kunna logga in ändå. Saknas `GLUE_API_KEY` deployas systemet i
**simulerat läge**: allt fungerar utom att ingen dörr faktiskt öppnas. Det är
avsiktligt, så du kan testa hela flödet innan låset är inkopplat.

`BOOTSTRAP_ADMIN_EMAILS` är det som gör att du kommer in i ett tomt system:
adresser i listan läggs in och befordras till admin vid inloggning. Töm gärna
den när medlemmarna är inlagda.

De två skripten går att köra lokalt också, om du vill:

```bash
npm run cf:ensure-d1        # skapar/hittar databasen
npm run cf:sync-secrets     # synkar hemligheter från din miljö
```

### Steg 3: Nycklar som kräver adressen

Två av integrationerna behöver veta var sidan ligger, så de görs enklast efter
första deployen.

**Google.** I [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
skapa en OAuth-klient av typen **Web application**:

- Authorized redirect URI: `https://lock.rt117.se/auth/google/callback`
- Lägg även till `http://localhost:5173/auth/google/callback` för lokal utveckling

**E-post.** Verifiera `rt117.se` som avsändardomän hos
[Resend](https://resend.com/domains). Resend visar exakt vilka DNS-poster som ska
in, normalt en DKIM-post (`TXT`), en post för returadressen och gärna SPF.
**Kopiera värdena från Resends gränssnitt**, de är unika per konto.

### Domänen

`wrangler.jsonc` kopplar `lock.rt117.se` som custom domain vid varje deploy
(`routes` med `custom_domain: true`). Det kräver att zonen `rt117.se` ligger i
samma Cloudflare-konto. Byter ni adress: uppdatera både `routes` och `APP_URL`
och committa. `APP_URL` styr Googles redirect-URI, stämmer den inte slutar
återhoppet fungera.

### Inställningar som inte är hemliga

Dessa bor i `wrangler.jsonc` och ändras genom att committa:

| Var | Betydelse |
| --- | --- |
| `APP_URL` | Sidans adress. Måste matcha Googles redirect-URI |
| `APP_NAME` | Visas i gränssnittet och i mejlen |
| `MAIL_FROM` | Avsändare, måste ligga på den verifierade domänen |
| `GLUE_MOCK` | `"1"` tvingar simulerat läge även med API-nyckel |

### Manuell deploy

Om du någon gång vill gå förbi GitHub:

```bash
npx wrangler login
npm run cf:ensure-d1
npm run db:migrate
npm run deploy
```

## Administrera medlemmar

Adminsidan ligger på `/admin` och har fem flikar:

- **Medlemmar**: lägg in en åt gången, redigera alla uppgifter (namn, e-post,
  telefon, klubb, roll, giltighetsdatum, anteckningar), pausa eller ta bort. Att
  pausa eller degradera någon dödar deras inloggningar direkt. Start- och
  slutdatum används för uthyrning: personen kan logga in men bara låsa upp inom
  sitt fönster.
- **Ansökningar**: godkänn eller avslå den som bett om åtkomst. Godkännande
  skapar medlemmen direkt och mejlar personen.
- **Importera**: klistra in flera rader, `epost;namn;klubb;telefon`. Semikolon,
  komma och tabb fungerar som avgränsare, så det går att klistra rakt från Excel
  eller Google Sheets. Rubrikrad hoppas över. Bara e-post är obligatoriskt.
- **Logg**: de senaste 200 händelserna. Vem loggade in, vem låste upp, vad admins
  ändrade.
- **Inställningar**: nödstoppet.

E-postadressen är nyckeln: den matchas mot Google-kontots adress eller mot den
adress engångskoden skickas till. Telefonnummer sparas men används inte för
inloggning ännu.

Systemet vägrar lämna dig utan admin. Sista aktiva adminen går inte att degradera,
avaktivera eller ta bort.

## Säkerhet

Det här öppnar en fysisk dörr, så några val är värda att förklara:

- **Ingen fri kontoregistrering.** Att verifiera en okänd adress ger bara
  tillgång till ansökningsformuläret. In i lokalen kommer man först när en admin
  godkänt ansökan.
- **Verifierad e-post krävs.** Google-inloggning kräver att adressen är
  verifierad hos Google, och engångskoden bevisar att personen läser inkorgen.
  Ingen kan ansöka i någon annans namn utan tillgång till adressen.
- **Koderna lagras aldrig i klartext** utan som HMAC med en separat hemlighet
  (`OTP_PEPPER`), bundna till adressen. Fem felförsök förbrukar koden, och en ny
  kod ogiltigförklarar den förra.
- **Ansökningscookien är avgränsad.** Egen HMAC-namnrymd skild från sessionerna,
  45 minuters livslängd, och ger bara rätt att skicka in formuläret.
- **Behörighet läses om vid varje anrop.** En pausad eller borttagen medlem är
  ute omedelbart, inte när cookien råkar gå ut.
- **Allt loggas.** Varje inloggning, ansökan och upplåsning hamnar i
  revisionsloggen med tidpunkt och IP.
- **Nödstopp.** En admin kan stänga av all upplåsning direkt, utan att deploya om.
- **Hastighetsbegränsning** på kodutskick, kodförsök, ansökningar och
  upplåsningar, både per person och globalt, så ett skenande fel inte kan mala
  mot Glue-kontot. Turnstile kan slås på ovanpå detta.
- **Konstant-tidsjämförelser** för signaturer och koder.

En avvägning att känna till: eftersom vem som helst kan begära en engångskod
(det är så ansökningsflödet startar) går det i princip att lista ut om en adress
är medlem genom att verifiera den och se vart man hamnar. Det kräver dock
tillgång till adressens inkorg, vilket vi bedömer som gott nog för en klubbdörr.

## Personuppgifter

**Detta behöver ägargranskas innan skarp drift.** Systemet behandlar
personuppgifter, och några punkter förtjänar ett medvetet beslut snarare än en
standardinställning:

- Revisionsloggen kopplar en namngiven person till en tidpunkt och en plats. Den
  gallras efter **365 dagar**, upplåsningshistoriken efter **90 dagar** och
  avgjorda ansökningar efter **180 dagar** (`RETENTION` i `src/index.ts`). Det är
  ett förslag, inte ett juridiskt ställningstagande. Bestäm vad som är rimligt
  och ändra siffrorna.
- Ansökningar innehåller namn, e-post och fritext som personen själv skrivit.
- Rättslig grund för behandlingen behöver fastställas, liksom vem som är
  personuppgiftsansvarig (rimligen föreningen).
- Cloudflare och Resend är personuppgiftsbiträden.

## Felsökning

| Symptom | Trolig orsak |
| --- | --- |
| "Simulerat läge" syns på sidan | `GLUE_API_KEY` saknas eller `GLUE_MOCK` är `"1"` |
| Låset svarar inte i tid | Hubben i lokalen saknar internet, eller låset är offline. Kolla batteri och uppkoppling på startsidan |
| Google-inloggningen kastar tillbaka ett fel | `APP_URL` stämmer inte med den riktiga adressen, eller redirect-URI:n är inte registrerad i Google Cloud Console |
| Ingen kod kommer fram | Domänen är inte verifierad hos Resend, eller mejlet fastnade i skräpposten |
| Medlem hamnar på ansökningssidan | Google-kontots adress skiljer sig från den som är inlagd i medlemslistan |
| Upplåsningsknappen är spärrad med datummeddelande | Medlemmens giltighetsfönster har inte börjat eller har gått ut. Ändra under Medlemmar → Redigera |
| Allt ger 429 | Hastighetsbegränsningen slog till. Vänta, eller töm `rate_limits` i D1 |
| Deployen stannar på "Kontrollera Cloudflare-uppgifter" | `CLOUDFLARE_API_TOKEN` eller `CLOUDFLARE_ACCOUNT_ID` saknas som GitHub-secret |
| Deployen stannar på "Synka hemligheter" | `SESSION_SECRET` eller `OTP_PEPPER` saknas. Generera med `npm run secrets:gen` |
| Deployen klagar på D1-behörighet | API-token saknar **Account → D1 → Edit** |
| Sista steget blir gult | Sidan svarade inte, oftast bara att DNS inte pekar rätt än. Deployen gick ändå igenom |

Loggar i realtid:

```bash
npx wrangler tail
```

## Kommandon

| Kommando | Vad det gör |
| --- | --- |
| `npm run dev` | Vite + Worker lokalt |
| `npm test` | Testsviten |
| `npm run typecheck` | TypeScript |
| `npm run build` | Bygger frontenden till `dist/client` |
| `npm run deploy` | Bygger och deployar manuellt (normalt sköter GitHub det) |
| `npm run db:migrate` / `:local` | Kör D1-migrationer |
| `npm run cf:ensure-d1` | Skapar/hittar D1-databasen och pekar konfigurationen på den |
| `npm run cf:sync-secrets` | Synkar hemligheter från miljön till Workern |
| `npm run glue:api-key` | Hämtar en Glue-API-nyckel |
| `npm run glue:locks` | Listar låsen på Glue-kontot |
| `npm run secrets:gen` | Slumpar `SESSION_SECRET` och `OTP_PEPPER` |

## Licens

MIT, se [LICENSE](LICENSE).
