# rt117-glue-lock

Lås upp RT117:s och RT36:s lokal i Linköping via hemsidan. Bröderna loggar in med
Google eller en engångskod till e-posten, trycker på en knapp, och Glue-låset öppnas.
Admins sköter medlemslistan i ett webbgränssnitt.

## Status

Repot var tomt (bara `README`, `LICENSE` och `.gitignore` från 2023) — hela systemet
är byggt från grunden i den här omgången. Det som finns nu:

| Del | Läge |
| --- | --- |
| Inloggning med Google (OAuth 2.0 + PKCE) | Klart, kräver OAuth-uppgifter |
| Inloggning med engångskod till e-post | Klart, kräver Resend-nyckel |
| Sessioner, återkallning, utloggning | Klart |
| Upplåsning mot Glue + statuspollning | Klart, kräver API-nyckel — går i simulerat läge tills dess |
| Admin: lägg in, pausa, ta bort, ändra roll | Klart |
| Admin: importera medlemmar från urklipp | Klart |
| Revisionslogg (vem loggade in, vem låste upp) | Klart |
| Nödstopp som stänger av upplåsning | Klart |
| Hastighetsbegränsning och botskydd | Klart, Turnstile valfritt |
| tabler.world-synk | Byggd men **avstängd** — se [tabler.world](#tablerworld) |
| SMS-koder | Ej byggt (du valde bort det). `phone` finns i databasen så det går att lägga på |

42 tester passerar (`npm test`), typkontrollen är grön och Workern bundlar till
**32 KiB gzippat** — långt under Workers free tier-gräns på 3 MiB.

### Vad som återstår innan det fungerar på riktigt

Allt nedan är konto- och konfigurationsarbete, ingen kodning:

1. Skapa Cloudflare-resurserna och deploya (§ [Driftsättning](#driftsättning)).
2. Hämta en Glue-API-nyckel och peka ut rätt lås.
3. Skapa en Google OAuth-klient.
4. Verifiera avsändardomän hos Resend och lägga DNS-poster på `rt117.se`.
5. Lägga in dig själv som admin och sedan resten av bröderna.
6. Låta någon titta på GDPR-frågan (§ [Personuppgifter](#personuppgifter)).

## Så fungerar det

```
Broderns telefon
      │  https://las.rt117.se
      ▼
Cloudflare Worker (Hono)  ──►  D1 (medlemmar, koder, logg)
      │
      │  Authorization: Api-Key …
      ▼
Glue Homes moln  ──►  Glue Hub i lokalen  ──(Bluetooth)──►  Låset
```

Det viktiga i den bilden: **upplåsningen går via Glues moln, inte via lokalen.**
Sidan ligger hos Cloudflare och behöver inget öppet nätverk i lokalen — men hubben
som sitter i lokalen måste ha internet för att kunna ta emot kommandot. Det var
precis det som blockerade projektet tidigare.

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

### Kodkarta

```
src/
  index.ts              Worker-ingång, felhantering, /api/me, nattlig städning
  types.ts              Env-bindningar och delade typer
  lib/                  crypto, normalisering, rate limiting, e-post, logg, inställningar
  auth/
    session.ts          Signerad sessionscookie (HMAC-SHA256)
    google.ts           OAuth 2.0 + PKCE
    otp.ts              Engångskoder
    middleware.ts       requireMember / requireAdmin
  members/
    repo.ts             CRUD mot D1
    source.ts           Medlemskälla bakom ett interface + bootstrap-admin
    tablerworld.ts      tabler.world-koppling (avstängd som standard)
  glue/client.ts        Glue-klient + mock
  routes/               auth, unlock, admin
web/                    React-frontend (Vite)
migrations/             D1-schema
scripts/                Glue-nyckel, låslista, hemligheter
```

## Kostnad

Allt ligger inom gratisnivåer. Kontrollera aktuella gränser hos leverantörerna —
de ändras då och då — men i grova drag:

- **Cloudflare Workers**: 100 000 anrop/dygn. En klubb med ett femtiotal bröder
  landar på några hundra.
- **Cloudflare D1**: gott och väl inom gratisnivån för den här datamängden.
- **Cloudflare Turnstile**: gratis.
- **Resend**: 100 mejl/dygn, 3 000/månad. Engångskoder för en klubb ligger långt under.

## Kom igång lokalt

```bash
npm install
cp .dev.vars.example .dev.vars
npm run secrets:gen          # klistra in värdena i .dev.vars
npx wrangler d1 create rt117-glue-lock
# lägg in database_id från utskriften i wrangler.jsonc
npm run db:migrate:local
npm run dev                  # Vite på :5173, Worker på :8787
```

Öppna http://localhost:5173. Sätt din egen adress i `BOOTSTRAP_ADMIN_EMAILS`
(i `wrangler.jsonc`) så läggs du in som admin första gången du loggar in.

Utan `RESEND_API_KEY` skickas inga mejl — **engångskoden skrivs i stället ut i
`wrangler dev`-loggen**, vilket är det bekväma sättet att testa lokalt. Utan
`GLUE_API_KEY` körs ett simulerat lås som beter sig som det riktiga.

```bash
npm test          # 42 tester
npm run typecheck
```

## Driftsättning

### 1. Databas och deploy

```bash
npx wrangler d1 create rt117-glue-lock     # lägg in database_id i wrangler.jsonc
npm run db:migrate                          # kör schemat i produktion
npm run deploy
```

### 2. Hemligheter

```bash
npm run secrets:gen                         # generera de två första
npx wrangler secret put SESSION_SECRET
npx wrangler secret put OTP_PEPPER
```

Byter du `SESSION_SECRET` loggas alla ut. Byter du `OTP_PEPPER` slutar redan
utskickade koder att fungera. Inget värre än så.

### 3. Glue

```bash
npm run glue:api-key                        # frågar efter Glue-inloggning, skriver ut en nyckel
npx wrangler secret put GLUE_API_KEY

GLUE_API_KEY='<nyckeln>' npm run glue:locks # visar låsen och deras id
npx wrangler secret put GLUE_LOCK_ID        # behövs bara om ni har flera lås
```

Sätt sedan `GLUE_MOCK` till `"0"` i `wrangler.jsonc` och deploya om.
Lösenordet till Glue-kontot skickas bara till Glue och sparas ingenstans.

### 4. Google-inloggning

I [Google Cloud Console](https://console.cloud.google.com/apis/credentials): skapa
en OAuth-klient av typen **Web application**.

- Authorized redirect URI: `https://las.rt117.se/auth/google/callback`
- Lägg även till `http://localhost:5173/auth/google/callback` för lokal utveckling.

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Utan dessa döljs Google-knappen automatiskt och bara engångskoder används.

### 5. E-post och DNS

Verifiera `rt117.se` som avsändardomän hos [Resend](https://resend.com/domains).
Resend visar exakt vilka poster som ska in — normalt en DKIM-post (`TXT`), en
`MX`/`TXT` för returadressen, och gärna en SPF-post. **Kopiera värdena från
Resends gränssnitt**, de är unika per konto.

```bash
npx wrangler secret put RESEND_API_KEY
```

Peka sedan `las.rt117.se` mot Workern: i Cloudflare-dashboarden under Workers &
Pages → din Worker → Settings → Domains & Routes → Add custom domain. Ligger
`rt117.se` inte redan i Cloudflare behöver zonen flyttas dit, eller så använder du
en adress under en domän som gör det.

Stämmer `APP_URL` i `wrangler.jsonc` inte med den riktiga adressen slutar Googles
återhopp att fungera — den styr redirect-URI:n.

### 6. Botskydd (valfritt)

Skapa en Turnstile-widget i Cloudflare-dashboarden och sätt:

```bash
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Utan dem är botskyddet av, men hastighetsbegränsningen gäller alltid.

### 7. Första inloggningen

Sätt `BOOTSTRAP_ADMIN_EMAILS` i `wrangler.jsonc` till din adress (flera går att
komma i en kommaseparerad lista) och deploya. Adresser i listan läggs in och
befordras till admin automatiskt vid inloggning — det är så du kommer in i ett
tomt system. Lägg sedan in resten av bröderna via adminsidan och töm gärna
variabeln när ni är igång.

## Administrera medlemmar

Adminsidan ligger på `/admin` och har fyra flikar:

- **Medlemmar** — lägg in en åt gången, pausa, ta bort, gör till admin. Att pausa
  eller degradera någon dödar deras inloggningar direkt.
- **Importera** — klistra in flera rader: `epost;namn;klubb;telefon`. Semikolon,
  komma och tabb fungerar som avgränsare, så det går att klistra rakt från Excel
  eller Google Sheets. Rubrikrad hoppas över. Bara e-post är obligatoriskt.
- **Logg** — de senaste 200 händelserna: vem loggade in, vem låste upp, vad admins
  ändrade.
- **Inställningar** — nödstoppet, och tabler.world.

E-postadressen är nyckeln: den matchas mot Google-kontots adress eller mot den
adress engångskoden skickas till. Telefonnummer sparas men används inte för
inloggning ännu.

Systemet vägrar lämna dig utan admin — sista aktiva adminen går inte att degradera,
avaktivera eller ta bort.

## tabler.world

Kopplingen är byggd men **avstängd som standard**, av tre skäl:

1. **Token.** Andra endpoints än ens egen profil kräver ett `global_auth_token`
   som beviljas av OVF/RTI. Det är inte något som går att ordna från koden.
2. **Overifierade detaljer.** Bas-URL (`https://api.roundtable.world/v1/app`) och
   att autentiseringen sker med en token i `Authorization`-headern är bekräftat.
   Det exakta ändpunktsnamnet för "medlemmar i en klubb" och fältnamnen i svaret
   är däremot **[verify]** — de står i dokumentationen på
   <https://developer.roundtable.world/>, som var blockerad från miljön där koden
   skrevs. Därför är sökvägen konfigurerbar (`TABLERWORLD_MEMBERS_PATH`, med
   `{clubId}` som platshållare) och fältmappningen tolerant mot olika namn.
3. **Personuppgifter.** Se nedan.

Så här verifierar du utan att skriva något till databasen:

```bash
npx wrangler secret put TABLERWORLD_TOKEN
npx wrangler secret put TABLERWORLD_CLUB_IDS      # id för RT117 och RT36, kommaseparerat
```

Gå sedan till Inställningar → **Testanrop**. Det visar vilken URL som anropades,
hur många rader som hittades och vilka fältnamn första raden har. Stämmer det inte
— justera `TABLERWORLD_MEMBERS_PATH` och testa igen. Först när testanropet ser rätt
ut är det läge att köra **Synka nu**.

Synken rör aldrig manuellt inlagda medlemmar. Bröder som försvunnit uppströms
avaktiveras (raderas inte) och tappar sina sessioner.

## Säkerhet

Det här öppnar en fysisk dörr, så några val är värda att förklara:

- **Ingen kontoregistrering.** Man kan bara logga in om adressen redan finns i
  medlemslistan. Google-inloggning kräver dessutom att adressen är verifierad hos
  Google, annars skulle någon kunna registrera ett konto på en broders adress.
- **Vi avslöjar inte vilka som är medlemmar.** Att begära en kod ger samma svar
  oavsett om adressen finns eller inte. Det hindrar kartläggning av medlemslistan,
  och gör att ingen kan använda oss för att skicka mejl till valfri adress.
- **Koderna lagras aldrig i klartext** utan som HMAC med en separat hemlighet
  (`OTP_PEPPER`), bundna till adressen. Fem felförsök förbrukar koden, och en ny
  kod ogiltigförklarar den förra.
- **Behörighet läses om vid varje anrop.** En pausad eller borttagen broder är ute
  omedelbart, inte när cookien råkar gå ut.
- **Allt loggas.** Varje inloggning och upplåsning hamnar i revisionsloggen med
  tidpunkt och IP.
- **Nödstopp.** En admin kan stänga av all upplåsning direkt, utan att deploya om.
- **Hastighetsbegränsning** på kodutskick, kodförsök och upplåsningar — både per
  person och globalt, så ett skenande fel inte kan mala mot Glue-kontot.
- **Konstant-tidsjämförelser** för signaturer och koder.

Jämförelser sker i konstant tid, men det är värt att veta att en Worker aldrig kan
ge fullständiga garantier mot mycket finkorniga tidsattacker. För det här
hotbilden — en klubbdörr — är det gott nog.

## Personuppgifter

**Detta behöver ägargranskas innan skarp drift.** Systemet behandlar
personuppgifter, och några punkter förtjänar ett medvetet beslut snarare än en
standardinställning:

- Revisionsloggen kopplar en namngiven person till en tidpunkt och en plats. Den
  gallras efter **365 dagar** och upplåsningshistoriken efter **90 dagar**
  (`RETENTION` i `src/index.ts`). Det är ett förslag, inte ett juridiskt
  ställningstagande — bestäm vad som är rimligt och ändra siffrorna.
- Rättslig grund för behandlingen behöver fastställas, liksom vem som är
  personuppgiftsansvarig (rimligen föreningen).
- Att hämta hem bröders e-post och telefonnummer från tabler.world är en
  utökad behandling som förtjänar ett eget beslut.
- Cloudflare och Resend är personuppgiftsbiträden.

## Felsökning

| Symptom | Trolig orsak |
| --- | --- |
| "Simulerat läge" syns på sidan | `GLUE_API_KEY` saknas eller `GLUE_MOCK` är `"1"` |
| Låset svarar inte i tid | Hubben i lokalen saknar internet, eller låset är offline. Kolla batteri och uppkoppling på startsidan |
| Google-inloggningen kastar tillbaka ett fel | `APP_URL` stämmer inte med den riktiga adressen, eller redirect-URI:n är inte registrerad i Google Cloud Console |
| Ingen kod kommer fram | Adressen finns inte i medlemslistan (vi säger inte det i gränssnittet — kolla i admin), eller domänen är inte verifierad hos Resend |
| "Den e-postadressen finns inte i medlemslistan" vid Google-inloggning | Google-kontots adress skiljer sig från den inlagda |
| Allt ger 429 | Hastighetsbegränsningen slog till. Vänta, eller töm `rate_limits` i D1 |

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
| `npm run deploy` | Bygger och deployar |
| `npm run db:migrate` / `:local` | Kör D1-migrationer |
| `npm run glue:api-key` | Hämtar en Glue-API-nyckel |
| `npm run glue:locks` | Listar låsen på Glue-kontot |
| `npm run secrets:gen` | Slumpar `SESSION_SECRET` och `OTP_PEPPER` |

## Licens

MIT, se [LICENSE](LICENSE).
