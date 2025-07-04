const express = require('express');
const path = require('path');
require('dotenv').config();
const cors = require('cors');
const session = require('express-session');
const { CosmosClient } = require('@azure/cosmos');
const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const bcrypt = require('bcrypt');
const upload = multer({ storage: multer.memoryStorage() });
const OpenAI = require('openai');
const app = express();
const port = process.env.PORT || 3000;

// Sessões
app.use(session({
    secret: 'segredo-super-seguro',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, sameSite: 'lax' } // muda isto em produção
}));

// Middlewares
app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Cosmos DB
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const cosmosClient = new CosmosClient({ endpoint, key });
const databaseId = "rent-a-ride";
const carrosContainer = cosmosClient.database(databaseId).container("carros");
const tiposCarroContainer = cosmosClient.database(databaseId).container("tipos_carro");
const tiposCombustivelContainer = cosmosClient.database(databaseId).container("tipos_combustivel");
const utilizadoresContainer = cosmosClient.database(databaseId).container("utilizadores");
const alugueresContainer = cosmosClient.database(databaseId).container("alugueres");

// Blob Storage
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const blobContainerClient = blobServiceClient.getContainerClient('clientes');

// Inicializar OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Rota principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint - Registo
app.post('/registo', upload.single('cartaConducao'), async (req, res) => {
    try {
        const { nome, dataNascimento, telemovel, email, user, pwd } = req.body;

        if (!nome || !dataNascimento || !telemovel || !email || !user || !pwd)
            return res.status(400).json({ message: 'Não introduziu campos obrigatórios.' });
        if (!req.file)
            return res.status(400).json({ message: 'Introduza a sua carta de condução.' });

        const hashedPwd = await bcrypt.hash(pwd, 12);
        const blobName = `${Date.now()}-${req.file.originalname}`;
        const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(req.file.buffer, {
            blobHTTPHeaders: { blobContentType: req.file.mimetype }
        });
        const cartaConducaoUrl = blockBlobClient.url;

        // construir o novo ID
        const { resources: utilizadores } = await utilizadoresContainer.items
            .query("SELECT VALUE COUNT(1) FROM c")
            .fetchAll();
        const totalUtilizadores = utilizadores[0];
        const novoID = `u${totalUtilizadores + 1}`;

        const novoUtilizador = {
            id: novoID,
            nome,
            dataNascimento,
            telemovel,
            email,
            username: user,
            password: hashedPwd,
            cartaConducaoUrl,
            criadoEm: new Date().toISOString()
        };
        await utilizadoresContainer.items.create(novoUtilizador);

        res.status(201).json({ message: 'Utilizador registado com sucesso!' });
    } catch (err) {
        console.error('Erro no registo:', err);
        res.status(500).json({ message: 'Erro interno ao registar utilizador.' });
    }
});

// Endpoint - Login
app.post('/login', async (req, res) => {
    const { user, pwd } = req.body;
    const query = {
        query: "SELECT * FROM c WHERE c.username = @user",
        parameters: [{ name: "@user", value: user }]
    };

    try {
        const { resources: utilizadores } = await utilizadoresContainer.items.query(query).fetchAll();
        if (utilizadores.length === 0)
            return res.status(401).json({ message: "Utilizador não encontrado." });

        const utilizador = utilizadores[0];
        const passwordCorreta = await bcrypt.compare(pwd, utilizador.password);
        if (passwordCorreta) {
            req.session.user = {
                idUtilizador: utilizador.id,
                nome: utilizador.nome,
                username: utilizador.username
            };
            return res.json({ success: true, idUtilizador: utilizador.id, nome: utilizador.nome });
        } else {
            return res.status(401).json({ message: "Palavra-passe incorreta." });
        }
    } catch (error) {
        console.error("Erro no login:", error);
        res.status(500).json({ message: "Erro interno." });
    }
});

// Endpoint - Tipos de carro
app.get('/tipos_carro', async (req, res) => {
    try {
        const { resources } = await tiposCarroContainer.items.query("SELECT * FROM tipos_carro").fetchAll();
        res.json(resources);
    } catch (error) {
        console.error('Erro ao obter os tipos de carro:', error);
        res.status(500).send('Erro');
    }
});

// Endpoint - Carros
app.get('/carros', async (req, res) => {
    try {
        const carrosQuery = { query: "SELECT * FROM carros c WHERE c.esta_disponivel = true" };
        const tiposCarroQuery = { query: "SELECT * FROM tipos_carro" };
        const tiposCombustivelQuery = { query: "SELECT * FROM tipos_combustivel" };

        const { resources: carros } = await carrosContainer.items.query(carrosQuery).fetchAll();
        const { resources: tiposCarro } = await tiposCarroContainer.items.query(tiposCarroQuery).fetchAll();
        const { resources: tiposCombustivel } = await tiposCombustivelContainer.items.query(tiposCombustivelQuery).fetchAll();

        for (let carro of carros) {
            const tipoCarro = tiposCarro.find(t => t.id === carro.tipo);
            const tipoCombustivel = tiposCombustivel.find(c => c.id === carro.tipo_combustivel);
            if (tipoCarro) carro.tipo = tipoCarro.nome;
            if (tipoCombustivel) carro.tipo_combustivel = tipoCombustivel.nome;
        }

        // os carros serão ordenados por ordem alfabético (modelo)
        carros.sort((a, b) => a.modelo.localeCompare(b.modelo));
        res.json(carros);
    } catch (error) {
        console.error('Erro ao obter carros:', error);
        res.status(500).send('Erro ao obter carros');
    }
});

// Endpoint - Carro por ID
app.get('/carros/:idCarro', async (req, res) => {
    const { idCarro } = req.params;

    const query = {
        query: "SELECT * FROM c WHERE c.id = @idCarro",
        parameters: [{ name: "@idCarro", value: idCarro }]
    };

    try {
        const { resources: carros } = await carrosContainer.items.query(query).fetchAll();
        if (carros.length === 0)
            return res.status(404).json({ message: "Carro não encontrado" });

        const carro = carros[0];

        const [tiposCarroData, tiposCombustivelData] = await Promise.all([
            tiposCarroContainer.items.query("SELECT * FROM c").fetchAll(),
            tiposCombustivelContainer.items.query("SELECT * FROM c").fetchAll()
        ]);

        const tipoCarro = tiposCarroData.resources.find(t => t.id === carro.tipo);
        const tipoCombustivel = tiposCombustivelData.resources.find(c => c.id === carro.tipo_combustivel);

        carro.tipo = tipoCarro? tipoCarro.nome: carro.tipo;
        carro.tipo_combustivel = tipoCombustivel? tipoCombustivel.nome : carro.tipo_combustivel;

        return res.json(carro);
    } catch (error) {
        console.error("Erro ao buscar carro:", error.message, error.stack);
        return res.status(500).json({ message: "Erro interno." });
    }
});

// Endpoint - POST Alugueres
app.post('/alugueres', async (req, res) => {
    const user = req.session.user;
    if (!user) {
        return res.status(401).json({ mensagem: "Para alugar um carro deve ter sessão iniciada." });
    }
    const { id_carro } = req.body;
    if (!id_carro) {
        return res.status(400).json({ mensagem: "ID do carro inválido." });
    }

    try {
        const queryUser = {
            query: "SELECT * FROM utilizadores u WHERE u.id = @id",
            parameters: [{ name: "@id", value: user.idUtilizador }]
        };
        const { resources: utilizadores } = await utilizadoresContainer.items.query(queryUser).fetchAll();
        const utilizador = utilizadores[0];
        if (!utilizador) 
            throw new Error("Utilizador não encontrado.");

        const queryCarro = {
            query: "SELECT * FROM carros c WHERE c.id = @id",
            parameters: [{ name: "@id", value: id_carro }]
        };
        const { resources: carros } = await carrosContainer.items.query(queryCarro).fetchAll();
        const carro = carros[0];
        if (!carro) 
            throw new Error("Carro não encontrado.");
        
        const { resources: alugueres } = await alugueresContainer.items
            .query("SELECT VALUE COUNT(1) FROM c")
            .fetchAll();

        const totalAlugueres = Number(alugueres[0]);
        const novoID = `a${totalAlugueres + 1}`;

        const novoAluguer = {
            id: novoID,
            id_utilizador: user.idUtilizador,
            id_carro: id_carro,
            criado_em: new Date().toISOString(),
            ativo: true,
            preco: carro.preco_base
        };
        await alugueresContainer.items.create(novoAluguer);
        carro.esta_disponivel = false;
        await carrosContainer.items.upsert(carro);

        const mensagem = `
            Olá ${utilizador.nome},

            O seu aluguer está confirmado!

            Detalhes:
            - Modelo: ${carro.modelo}
            - Custo: €${carro.preco_base}/dia

            Obrigado por usar o RENT-A-RIDE!

            Gabriel Charro
            Guilherme Lopes
            João Pires
            `;

        const resposta = await fetch("https://rent-a-ride-email-app.azurewebsites.net/api/enviaMail", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                recipient: utilizador.email,
                subject: "RENT-A-RIDE | Confirmação de Aluguer",
                message: mensagem.trim()
            })
        });

        if (!resposta.ok) {
            const erro = await resposta.text();
            console.error(`Erro no serviço de email: ${erro}`);
            return res.status(201).json({
                mensagem: "Aluguer criado, mas erro ao enviar o e-mail.",
                detalheErroEmail: erro
            });
        }

        const textoResposta = await resposta.text();
        let resultado;
        try {
            resultado = JSON.parse(textoResposta);
        } catch {
            resultado = textoResposta;
        }

        return res.status(201).json({
            mensagem: "Aluguer criado com sucesso e e-mail enviado.",
            resultado
        });
    } catch (erro) {
        console.error("Erro ao criar aluguer ou enviar email:", erro);
        return res.status(500).json({ mensagem: "Erro interno ao criar aluguer." });
    }
});

// Endpoint - GET Alugueres
app.get('/alugueres', async (req, res) => {
    const user = req.session.user;
    if (!user) {
        return res.status(401).json({ mensagem: "Não autenticado." });
    }

    try {
        const query = {
            query: "SELECT * FROM alugueres a WHERE a.id_utilizador = @id AND a.ativo = true",
            parameters: [{ name: "@id", value: user.idUtilizador }]
        };
        const { resources: alugueres } = await alugueresContainer.items.query(query).fetchAll();

        const alugueresComCarro = await Promise.all(alugueres.map(async (a) => {
            const queryCarro = {
                query: "SELECT c.modelo FROM carros c WHERE c.id = @id",
                parameters: [{ name: "@id", value: a.id_carro }]
            };
            const { resources: carros } = await carrosContainer.items.query(queryCarro).fetchAll();
            const modelo = carros[0]?.modelo || "Desconhecido";
            
            return {
                modelo,
                criado_em: a.criado_em,
                preco: a.preco,
                id: a.id
            };
        }));

        res.json(alugueresComCarro);
    } catch (err) {
        console.error("Erro ao buscar alugueres:", err);
        res.status(500).json({ mensagem: "Erro interno ao obter alugueres." });
    }
});

// Endpoint - DELETE Alugueres
app.delete('/alugueres/:id', async (req, res) => {
    const user = req.session.user;
    const id = req.params.id;
    if (!user) 
        return res.status(401).json({ mensagem: "Não autenticado." });

    try {
        const query = {
            query: "SELECT * FROM alugueres a WHERE a.id = @id AND a.id_utilizador = @uid",
            parameters: [
                { name: "@id", value: id },
                { name: "@uid", value: user.idUtilizador }
            ]
        };
        const { resources } = await alugueresContainer.items.query(query).fetchAll();
        const aluguer = resources[0];
        if (!aluguer) 
            return res.status(404).json({ mensagem: "Aluguer não encontrado." });

        // atualizar o estado do aluguer
        aluguer.ativo = false;
        await alugueresContainer.items.upsert(aluguer);

        const queryUser = {
            query: "SELECT * FROM utilizadores u WHERE u.id = @id",
            parameters: [{ name: "@id", value: user.idUtilizador }]
        };
        const { resources: utilizadores } = await utilizadoresContainer.items.query(queryUser).fetchAll();
        const utilizador = utilizadores[0];
        if (!utilizador) 
            throw new Error("Utilizador não encontrado.");

        const queryCarro = {
            query: "SELECT * FROM carros c WHERE c.id = @id",
            parameters: [{ name: "@id", value: aluguer.id_carro }]
        };
        const { resources: carros } = await carrosContainer.items.query(queryCarro).fetchAll();
        const carro = carros[0];
        if (!carro) 
            throw new Error("Carro não encontrado.");

        // atualizar a kilometragem do carro com um valor pseudoaleatório calculado em função do tempo do aluguer
        function gerarQuilometros(timestampInicio) {
            const inicio = new Date(timestampInicio);
            const agora = new Date();

            // Tempo decorrido em horas
            const horas = Math.max((agora - inicio) / (1000 * 60 * 60), 0.1); // mínimo 0.1h

            // Fator aleatório controlado (entre 0.75 e 1.25)
            const seed = (inicio.getTime() % 100000) / 100000;
            const fatorAleatorio = 0.75 + (seed * 0.5); // entre 0.75 e 1.25

            // Velocidade média base (entre 30 e 90 km/h)
            const velocidadeBase = 30 + (seed * 60); // entre 30 e 90

            // Cálculo final
            const quilometros = Math.floor(horas * velocidadeBase * fatorAleatorio);

            return quilometros;
        }
        const kilometrosPercorridos = gerarQuilometros(aluguer.criado_em);
        carro.n_km += kilometrosPercorridos;
        carro.esta_disponivel = true;
        await carrosContainer.items.upsert(carro);

        const mensagem = `
            Olá ${utilizador.nome},

            O seu aluguer terminou!

            Detalhes:
            - Modelo: ${carro.modelo}
            - Custo final: €${aluguer.preco.toFixed(2)}
            - Distância percorrida: ${kilometrosPercorridos} km

            Obrigado por usar o RENT-A-RIDE!

            Gabriel Charro
            Guilherme Lopes
            João Pires
            `;

        const resposta = await fetch("https://rent-a-ride-email-app.azurewebsites.net/api/enviaMail", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                recipient: utilizador.email,
                subject: "RENT-A-RIDE | Fim de Aluguer",
                message: mensagem.trim()
            })
        });

        if (!resposta.ok) {
            const erro = await resposta.text();
            console.error(`Erro no serviço de email: ${erro}`);
            return res.status(201).json({
                mensagem: "Aluguer terminado, mas erro ao enviar o e-mail.",
                detalheErroEmail: erro
            });
        }
        res.status(204).end();
    } catch (err) {
        console.error("Erro ao parar aluguer:", err);
        res.status(500).json({ mensagem: "Erro interno." });
    }
});

// Endpoint - Chat com assistente
app.post('/api/assistente', async (req, res) => {
    const { pergunta } = req.body;

    try {
        const resposta = await openai.chat.completions.create({
            model: "gpt-4.1-nano",
            messages: [
                { role: "system", content: "És o assistente da empresa de aluguer de carros RENT-A-RIDE." },
                { role: "user", content: pergunta }
            ],
            temperature: 0.4,
            max_tokens: 300
        });

        res.json({ resposta: resposta.choices[0].message.content });
    } catch (err) {
        console.error("Erro no assistente:", err);
        res.status(500).json({ erro: "Erro ao obter resposta do assistente." });
    }
});

// Endpoint - Perfil
app.get('/perfil', (req, res) => {
    if (req.session.user) {
        res.json({ autenticado: true, utilizador: req.session.user });
    } else {
        res.status(401).json({ autenticado: false, message: "Não autenticado." });
    }
});

// Endpoint - Logout
app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ message: "Erro ao terminar sessão." });
        res.json({ message: "Sessão terminada." });
    });
});

app.listen(port, () => {
    console.log(`Servidor a correr em http://localhost:${port}`);
});
