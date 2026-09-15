# Prvo povezivanje

Instaliraj Windows x64 Setup EXE iz Releases i pokreni AgentHub. Node.js nije potreban za instaliranu aplikaciju. Agenti i SSH klijent moraju vec da budu instalirani na svojim masinama.

## Cetiri Hermesa na VPS-u

1. Otvori Machines. U Quick connect upisi `root@tvoj-server:22` ili svoj SSH alias. Sacuvaj masinu.
2. Klikni Terminal, proveri fingerprint servera i obavi SSH autentifikaciju. Za kljuc sa passphrase-om koristi lokalni ssh-agent. Ako remote terminal prijavi da nema tmux-a, instaliraj ga na tom serveru; aplikacija to ne radi bez tvog odobrenja.
3. Klikni Discover agents na toj masini. Dodaj pronadjene profile pojedinacno. Za vec aktivan Hermes gateway koristi API konekciju, ne novi CLI pisac nad istim profilom.
4. Odobri uvoz odgovarajuceg gateway tokena ili ga unesi rucno. Connect, pa prva poruka.
5. Ponovi za ostale profile/masine. Sidebar cuva odvojene razgovore.

Gateway API treba da slusa samo na lokalnom interfejsu VPS-a. AgentHub mu pristupa privatnim SSH tunelom. Javni API port nije potreban. Sacuvani SSH alias automatski koristi njegove User/Port/IdentityFile/ProxyJump opcije.

## Lokalni agenti

Discover pronalazi poznate CLI instalacije/profil foldere i nekoliko standardnih loopback portova. Pregledaj rezultat pre dodavanja. Terminal moze da otvori native shell ili agentov CLI. Docker/WSL-specificni launcheri se u ovoj verziji podesavaju rucno.

## Zatvaranje

X zatvara prozor u tray. Exit window odvaja UI, ali odvojeni proces zadrzava sesije i terminale. Ponovno otvaranje se kaci na isti proces. Stop all sessions and exit namerno gasi lokalne procese; istorija i draftovi ostaju. Posle restartovanja Windowsa lokalni proces ne moze magicno da ostane ziv: vidi se sacuvana istorija i nastavlja se podrzana native chat sesija. Remote tmux nastavlja rad kada se SSH klijent prekine, ali ne garantuje opstanak kroz restart samog VPS-a.

U slucaju problema sa prikazom pokreni AgentHub.exe sa `--safe-graphics`. Lokalni log startovanja je u AgentHub userData folderu pod AppData. Nemoj slati fajl vault.json, session-service.json ili privatne SSH kljuceve drugim ljudima.
