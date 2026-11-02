# MultiCodex

Hub locale per Windows per gestire più account ChatGPT usati nell’app Codex. Nessun limite al numero di account configurabili. Interfaccia italiana, senza dipendenze npm.

## Come iniziare

1. Apri **MultiCodex** dal collegamento sul desktop. L’account attualmente salvato in Codex viene importato al primo avvio.
2. Premi **Aggiungi account**. Puoi inserire un’etichetta e una **email GamsGo**: quest’ultima è un promemoria separato dall’email ChatGPT.
3. Nella finestra browser dedicata, effettua personalmente l’accesso con l’account da aggiungere e completa le eventuali verifiche. La finestra usa un profilo separato dal browser abituale. Dopo il successo puoi chiuderla.
4. Torna all’hub: l’account viene aggiunto automaticamente e vengono letti i dati di utilizzo. Ripeti per il terzo account o per quelli futuri.
5. Quando Codex ha terminato le attività, premi **Usa questo account**. L’hub verifica l’accesso, salva la sessione precedente, riavvia Codex e installa quella selezionata. Al primo cambio reale controlla **nome ed email nel profilo dell’app Codex**.

Non occorre modificare script per aggiungere altri account. **Modifica** cambia etichetta ed email GamsGo, **Ricollega** rinnova un accesso, **Rimuovi** elimina solo il riferimento nell’hub. Il nome e l’email ChatGPT sono letti dall’account; quando il nome non è disponibile l’hub lo segnala e puoi scegliere un’etichetta.

## Dati mostrati

- Nome e email ChatGPT, etichetta personale, email GamsGo separata, piano e account attivo rilevato.
- Percentuale rimasta nelle finestre di 5 ore e settimanale, data/ora del ripristino e tempo mancante. Le etichette dipendono dalla durata restituita dal servizio.
- Numero di banked reset e dettaglio delle scadenze disponibile. Un dato mancante non viene mostrato come zero. Il conteggio restituito dal servizio prevale sul numero delle scadenze elencate.
- Ora dell’ultimo aggiornamento riuscito. I dati vengono richiesti all’avvio dell’hub, dopo un accesso e tramite **Aggiorna**; in modalità automatica vengono inoltre applicati gli intervalli salvati nelle Impostazioni. La lettura ordinaria della schermata consulta lo stato locale.

## Impostazioni e nomi

La voce **Impostazioni** nel menu permette di scegliere **Manuale** (predefinito) o **Automatico**. In automatico, gli intervalli iniziali sono **60 secondi per l’account attivo** e **5 minuti per ciascun account inattivo**. Entrambi sono modificabili e vengono salvati nell’archivio cifrato. I pulsanti manuali restano disponibili. L’aggiornamento automatico richiede una finestra dell’hub visibile, si sospende durante login e cambio account, non sovrappone le richieste e aumenta l’attesa dopo un errore. Dopo la chiusura anomala di una finestra, la sua presenza scade entro 20 secondi. Un’operazione già in corso può completarsi dopo che la finestra viene nascosta.

Ogni scheda distingue **Nome profilo**, **Username**, **Nome accesso** ed **Email account**. Nome profilo e username sono letti dal servizio di profilo usato dal client Codex installato (`/backend-api/wham/profiles/me`); il nome accesso proviene dalle credenziali OAuth e può essere diverso. Il servizio di profilo è un’interfaccia interna: se cambia o non risponde, la lettura dei limiti continua a funzionare e i nomi precedenti vengono mantenuti. Un aggiornamento manuale rilegge anche il profilo; in automatico il profilo ha una cache di 15 minuti, separata dagli intervalli dei limiti. Etichetta ed email GamsGo rimangono campi indipendenti modificabili dall’utente.

Date e orari sono mostrati nel fuso **Europe/Rome**. I reset non vengono consumati dall’hub. Un reset già trascorso viene segnalato come in attesa di aggiornamento; non si inventano nuove percentuali.

## Progetti e conversazioni

La voce **Progetti** mostra i progetti locali collegati all’app Codex. Puoi cercarli per nome o percorso e ordinarli come in Codex, per nome, ultima attività, dimensione o prompt registrati. **Dettagli** apre le cartelle associate, i percorsi dei dati Codex e delle conversazioni, le attività, la reportistica del disco, lo stato Git e l’elenco delle conversazioni. Ogni conversazione espone i propri percorsi, compresi i database condivisi e gli eventuali file non più presenti. Cliccando una conversazione puoi leggere i prompt e le risposte, comprese le note di avanzamento, e caricare i messaggi precedenti. Non vengono mostrati ragionamenti interni o output degli strumenti.

La lettura usa esclusivamente i cataloghi locali di Codex (`.codex-global-state.json`, `state_5.sqlite`, `thread_history_1.sqlite` e i cataloghi precedenti, quando presenti). I database SQLite sono aperti **in sola lettura**; come ripiego si leggono i file delle conversazioni locali. Non si avviano motori Codex, non si effettuano accessi agli account e non si interrogano servizi remoti per questa sezione. I dati riguardano i progetti e le conversazioni conservati nel profilo locale, indipendentemente dall’account attivo nell’hub; non sono un inventario delle chat cloud di tutti gli account.

I progetti migrati vengono unificati per percorso e le conversazioni assegnate tramite il progetto salvato o la cartella di lavoro più specifica. Le conversazioni dei sottoagenti sono conteggiate separatamente e non aumentano il numero dei tuoi prompt. I conteggi comprendono le conversazioni archiviate. Cronologie assenti o non leggibili sono segnalate: un conteggio parziale non viene presentato come completo. Le modifiche della conversazione in corso compaiono dopo che Codex le ha salvate e dopo **Aggiorna progetti**.

La prima apertura della sezione avvia una scansione in background; i successivi aggiornamenti si richiedono con **Aggiorna progetti**. Le impostazioni di aggiornamento degli account non si applicano ai progetti. Il catalogo e i risultati restano nella memoria dell’hub; nessuna copia delle conversazioni viene scritta nella cartella del repository.

**File progetto** è la dimensione logica dei file: include file nascosti, `.git`, dipendenze e output generati. Il dettaglio separa queste categorie e mostra tipi di file e file più grandi. I percorsi sovrapposti nello stesso progetto vengono deduplicati; lo spazio complessivo è la somma dei progetti e può contare più volte cartelle condivise tra progetti diversi. Non si seguono link simbolici o junction. Ogni scansione è limitata a circa 250.000 file, 2 minuti e 64 livelli di profondità per progetto; accessi negati e limiti producono risultati dichiaratamente parziali. Una cartella non trovata mantiene la propria scheda con spazio non disponibile.

**Prima attività** usa il timestamp del primo messaggio utente disponibile nella cronologia, escludendo i sottoagenti. Se non è disponibile alcun timestamp di prompt, usa la data di aggiunta del progetto a Codex. **Ultima attività** considera i messaggi e gli aggiornamenti delle conversazioni. Le date di creazione della cartella e di aggiunta a Codex non vengono mostrate come campi separati. I token sono il contatore storico locale di Codex, non la percentuale di quota residua. Il tempo di elaborazione è la somma delle durate dei turni registrati, non il tempo totale trascorso a lavorare. Lo stato Git è letto con i lock opzionali disabilitati e confrontato solo con i riferimenti già presenti sul PC: nessun fetch, commit o push. Gli indirizzi dei remoti vengono ripuliti da credenziali e parametri prima di essere mostrati. Il formato dei cataloghi Codex è interno e può cambiare con gli aggiornamenti dell’app.

**Dati Codex** riporta separatamente conversazioni, log e altri dati attribuibili al progetto (inclusi sottoagenti). I file delle sessioni, gli archivi compressi, gli artefatti e le cartelle identificate tramite gli ID delle conversazioni o del progetto vengono pesati senza aprirne il contenuto. Sono inclusi anche `.codex`, `AGENTS.md` e `AGENTS.override.md` nella cartella del progetto, quando presenti; questi file sono già compresi nel peso dei file del progetto, quindi i due totali non vanno sommati.

Per i database di cronologia, log, stato, memorie e cataloghi viene misurato il contenuto logico delle righe associate tramite gli ID del progetto e delle conversazioni. Il totale dei dati Codex è **indicativo**: somma file dedicati e payload logico delle righe, senza pretendere una suddivisione fisica di pagine SQLite, indici, spazio libero o WAL. I percorsi dei database e dei relativi WAL/SHM mostrano anche la dimensione dell’intero archivio condiviso, che non viene attribuita per intero a ciascun progetto. Preferenze globali, cache e log senza un collegamento certo restano riferimenti condivisi o non attribuiti. Tutte le letture rimangono locali e in sola lettura.

## Stato della prima versione

Verificati sull’installazione locale: individuazione del motore Codex, importazione del primo account, lettura reale dei due limiti e dei banked reset, crittografia Windows, avvio del collegamento e apertura della finestra. La lettura ha lasciato invariato il file di autenticazione usato dall’app.

I test automatici coprono cambio e recupero con un motore simulato. **Il cambio tra due account reali e l’aggiunta con accesso interattivo richiedono la prima prova con l’utente.** L’indicatore “attivo” è ricavato dalle credenziali locali: dopo il primo cambio va confrontato con il profilo visibile in Codex. La verifica visiva automatica della finestra è stata bloccata dal controllo URL di Computer Use.

La versione 0.1.2 avvia il pacchetto Microsoft Store tramite `IApplicationActivationManager`, anziché eseguire direttamente il file in WindowsApps (che su questa installazione restituisce Accesso negato). L’attivazione Windows è stata provata realmente con esito positivo mentre l’app era aperta. Prima di chiudere Codex, il cambio verifica questa attivazione; dopo l’avvio attende finestra e motore, con un limite di tentativi. In caso di errore distingue il punto di guasto e verifica il recupero prima di dichiararlo riuscito.

L’hub riutilizza la cartella Codex esistente e non modifica il programma installato. La continuità di funzioni cloud e collegamenti ad altri servizi può dipendere dall’account scelto. La chiusura di Codex può interrompere attività in corso: cambia account quando sono terminate.

## Installazione e avvio

Richiede Windows, l’app Codex installata, **Node.js 22.13+** (anche quello già fornito dal runtime locale Codex) e Edge o Chrome. Non richiede API key né pacchetti npm.

Per ricreare il collegamento, esegui `Installa-Collegamento.ps1` con Windows PowerShell. Il collegamento avvia `Avvia-MultiCodex.ps1`. Non spostare questa cartella senza ricreare il collegamento.

L’hub è una finestra locale del browser in modalità applicazione. Il processo locale resta disponibile dopo la chiusura della finestra, così il collegamento riapre la stessa istanza. Il collegamento registra una task Windows denominata `MultiCodexHub-<SID utente>` e la avvia su richiesta con l’utente già connesso e privilegi normali: non salva password e non ha trigger periodici né di avvio automatico. Questo avvio separato impedisce alla chiusura di Codex di terminare anche il processo che deve riaprirlo. Dopo un riavvio del computer, il collegamento riavvia anche il processo locale.

La versione 0.1.3 verifica anche l’albero dei processi prima del cambio: se l’hub dipende ancora da Codex, rifiuta di chiuderlo. La chiusura forza soltanto il processo desktop verificato, senza terminare ricorsivamente tutto l’albero. `switch-status.json` conserva la fase raggiunta dal cambio; i file `hub-output.log` e `hub-errors.log` permettono di diagnosticare l’avvio del processo indipendente.

## Dati locali e recupero

Archivio in `%LOCALAPPDATA%\MultiCodex`:

- `accounts.dpapi`: account, sessioni, email GamsGo e ultimi dati, cifrati con **Windows DPAPI CurrentUser**; `accounts.dpapi.bak` conserva la versione precedente cifrata.
- `work`: cartelle temporanee con permessi riservati all’utente. Le credenziali necessarie al motore Codex sono presenti in chiaro solo durante le operazioni; le sessioni aggiornate vengono ricifrate e le cartelle eliminate. In caso di arresto anomalo l’hub recupera eventuali token aggiornati prima della pulizia.
- `browser`: profili browser dedicati agli accessi; `hub-browser`: profilo della finestra dell’hub.
- `runtime.json`: riferimento al server locale e segreto per accedere all’hub, protetti dai permessi della cartella.
- `endpoint.json`: indirizzo e segreto stabili dell’hub, mantenuti anche dopo il riavvio del servizio per non scollegare le finestre già aperte.

Per l’account attivo, la reportistica non usa il refresh token: il rinnovo resta di competenza del Codex aperto. Per quelli inattivi, le credenziali rinnovate dal motore vengono salvate nell’archivio. Non si esegue `codex logout` durante i cambi.

Se un cambio viene interrotto, l’archivio conserva un salvataggio cifrato dell’account precedente e l’hub offre **Ripristina account precedente**. Il pulsante riavvia Codex. Non cancellare la cartella dati per risolvere un errore di accesso: prima prova **Ricollega**.

Il server ascolta solo su `127.0.0.1`, richiede un segreto casuale per le operazioni, verifica Host/Origin e non invia credenziali alla pagina. Nessun servizio di hosting o cloud aggiuntivo. I dati degli account vengono naturalmente richiesti ai servizi Codex/OpenAI.

## Sviluppo

```powershell
node --test
node src/server.mjs
```

L’avvio diretto con Node è utile per lo sviluppo e la reportistica. Per un cambio reale usa il collegamento desktop, che avvia l’host indipendente tramite Windows.

`src/rpc.mjs` implementa il protocollo JSON-RPC del motore installato. `src/hub.mjs` gestisce profili, accessi, limiti e cambio con recupero. `src/vault.mjs` gestisce l’archivio. `scripts/windows.ps1` integra DPAPI, rilevamento installazione, browser e riavvio dell’app. `public` contiene l’interfaccia.

Riferimenti: [Autenticazione Codex](https://learn.chatgpt.com/docs/auth), [App-server e limiti](https://learn.chatgpt.com/docs/app-server).

L’etichetta iniziale segue il nome profilo. Da Modifica puoi impostare un titolo personalizzato; lasciando il campo vuoto si torna al nome profilo automatico. La riga Email GamsGo compare immediatamente dopo Email account, con lo stesso stile, soltanto se compilata. I valori preesistenti del campo personale vengono conservati.
