# Pencil

Plugin Codex pour ouvrir les fichiers `.pen` dans une vue Pencil intégrée, sans chat supplémentaire. Un service Node conserve un canal par session de design ; les agents partagent une session par son `sessionId` et réservent leurs séquences de modifications.

## Organisation

Ce dépôt contient un seul plugin indépendant. Le nom affiché dans Codex est **Pencil**. Les sources, tests et bundles installables vivent à la racine du dépôt.

Lis [le manifeste](plugin.json) pour l’identité du plugin et [le raccordement MCP](mcp.json) pour son serveur stdio. Lis [le serveur](src/server.mjs) pour l’ouverture déclenchée par l’agent, [le gestionnaire de sessions](src/sessions.mjs) pour les réservations et [la vue](web/editor.mjs) pour le pont Pencil.

## Installation et validation

Prérequis : Codex avec les plugins et MCP Apps activés, Node.js 22 ou supérieur et un accès réseau à pen.dev.

Depuis le dépôt public :

```bash
codex plugin marketplace add julien-m/pencil
codex plugin add pencil@pencil
```

Les bundles installables sont inclus dans Git ; aucune compilation n’est nécessaire pour l’installation. Recharger les plugins ou démarrer une nouvelle conversation pour charger les outils si nécessaire.

Pour développer ou installer depuis un clone local, installer également Bun :

```bash
git clone https://github.com/julien-m/pencil.git
cd pencil
bun install --frozen-lockfile
bun run build
bun run test
bun run test:protocol
codex plugin marketplace add "$PWD"
codex plugin add pencil@pencil
```

Les bundles dans `dist/` doivent exister lors de l’installation. Le runtime installé ne dépend pas de `node_modules` ; les dépendances servent au développement et aux tests. Node 22 ou supérieur est requis.

Le plugin utilise le moteur web hébergé sur `https://app.pen.dev/new?embed`. Il ne redistribue pas le moteur propriétaire Pencil et ne fonctionne pas hors ligne. L’hôte doit autoriser les MCP Apps, le frame enfant pen.dev et la connexion WebSocket au service local. Une installation réussie ne prouve pas que l’hôte respecte toutes ces capacités.

## Utilisation

- Demander à l’agent d’utiliser le plugin Pencil installé : appeler `pencil_open` avec le chemin absolu et une clé `scope` de session explicite. L’outil retourne la ressource UI ; son affichage effectif dépend de l’hôte.
- Attendre le chargement du moteur, puis appeler `pencil_tools` et lire les instructions natives avec `pencil_call(read_skill)`.
- Appeler `pencil_begin` avant un lot, `pencil_call` pour les opérations, relire, puis `pencil_end`.
- Transmettre le même `sessionId` aux agents qui partagent le document. Ne pas employer une autre clé `scope` pour ouvrir une deuxième fois le même fichier.

Les scopes implicites proviennent de `CODEX_THREAD_ID` lorsqu’il est disponible, sinon du processus MCP. Ils ne garantissent pas une identité native de chat : le partage multi-agent doit utiliser explicitement l’identifiant retourné. `agent` est un libellé d’activité, pas une identité authentifiée.

## Captures, exports et emplacements choisis

| Outil | Résultat |
|---|---|
| `pencil_new` | Crée un `.pen` au chemin absolu choisi, puis retourne sa vue |
| `pencil_capture` | Capture des IDs de composants/vues, ou `["document"]` pour le projet entier ; écrit les PNG dans le dossier choisi |
| `pencil_export` | Exporte PNG, JPEG, WEBP, PDF, HTML/CSS ou HTML/Tailwind ; retourne les chemins réellement écrits |
| `pencil_save_as` | Copie le dernier snapshot acquitté vers un nouveau `.pen` au chemin choisi |

Les dossiers de destination doivent exister. Aucun de ces outils n’écrase une destination existante. Les captures et exports nécessitent la réservation de la session. Les fichiers `.pen` restent opaques : le moteur gère leur contenu et le plugin transporte les octets.

## Navigation et activité des agents

Le panneau contient le véritable éditeur : ses outils de sélection, zoom et panneau Layers restent disponibles pour naviguer entre les frames et maquettes. Les panneaux et fonctions disponibles restent ceux exposés par la version web de Pencil.

Le bandeau du plugin affiche le nom de l’agent qui a réservé le document. L’interface se met à jour via le canal local pendant son travail. Le pont public inspecté n’expose pas d’API de présence ou de curseurs agents : ces badges ne constituent pas des étiquettes natives attachées aux objets du canvas. Cette capacité supplémentaire reste à confirmer avec pen.dev.

## Sauvegardes et protections

Le plugin ouvre le document uniquement lorsque l’agent appelle `pencil_open` ou `pencil_new`. Il ne déclare aucune association automatique aux fichiers `.pen`.

Pour la sauvegarde, le service sauvegarde dans un draft séparé sous son dossier de données. Il ne remplace jamais le fichier source. Cette distinction évite la fenêtre de perte de données d’un simple contrôle de hash suivi d’un renommage. Le chemin du draft figure dans `pencil_status` ; il se rouvre dans Pencil. Il n’existe pas de commande d’export du draft vers l’original dans cette version.

Les assets sont limités à `images/` et `fonts/` dans le dossier du document. Les chemins contenant une traversée, les liens symboliques et les fichiers `.pen` utilisés comme assets sont refusés. Les bibliothèques `.pen` externes ne sont pas prises en charge par ce stockage initial.

Une réservation protège les appels des agents, pas les gestes humains dans l’éditeur. Ne pas lancer de mutations automatiques pendant une édition manuelle. Un timeout bloque les nouvelles mutations ; ne pas rejouer une insertion dont le résultat est inconnu. La génération asynchrone n’est pas supportée ; le rejet syntaxique de `Generate(...)` est un avertissement d’usage, pas une sandbox JavaScript.

## Données et cycle de vie

`PLUGIN_DATA`, lorsqu’il est fourni par l’hôte, contient le point de connexion privé du service et les drafts. Sinon, le plugin utilise son dossier `.runtime/`. Le service écoute uniquement sur loopback et exige un jeton privé ; chaque vue dispose d’un jeton limité à sa session.

Le service survit à la fermeture d’un client MCP. Pour l’arrêter explicitement, lire le PID dans `connection.json` de son dossier de données et envoyer SIGTERM. Ne pas supprimer les drafts utiles. Après un arrêt brutal pendant le démarrage, un dossier `starting` peut devoir être retiré après vérification de l’absence du service.

## Sources et statut

Consulte [la proposition officielle d’embed](https://github.com/highagency/pen-embed-demo), [le format de plugin](https://developers.openai.com/plugins/build/plugins).

Le transport, les sessions et le protocole MCP ont des tests locaux. Le moteur de production a été chargé dans le navigateur intégré, modifié par deux agents de test successifs et rechargé avec leurs changements. Le contrat MCP confirme que `pencil_open` retourne la vue de sa session. Le rendu effectif du panneau dans une session Codex doit être vérifié séparément ; le test navigateur ne le certifie pas.

## Licence et indépendance

Ce plugin est une intégration indépendante, sans affiliation ni approbation de Pencil ou OpenAI. Lis [la licence MIT](LICENSE) pour le code de cette intégration et [les notices des dépendances](THIRD-PARTY-NOTICES.md) pour les bibliothèques incluses. Le moteur Pencil hébergé reste soumis aux conditions de son éditeur.

Aucune clé API n’est embarquée. Les jetons du canal local sont générés à l’exécution et les documents/drafts restent dans le stockage local du plugin ; leur contenu est traité par le moteur web hébergé. Ne pas utiliser de document sensible sans vérifier les conditions et le comportement réseau de pen.dev.
