
        // Estado Global da Aplicação
        const app = {
            screens: [],
            currentScreenIndex: -1,
            navigationRules: [],
            fields: [],
            currentFieldIndex: 0,
            cursorRow: 0,
            cursorCol: 0,
            pendingFiles: [],
            dataMapping: {},
            validationKeys: ['ENTER'], // Teclas que ativam validação de campos
            activeCodeTab: 'cics',
            editMode: false           // true quando o editor de layout estiver aberto
        };

        const ROWS = 24;
        const COLS = 80;

        /* ── Flag de alterações não salvas ── */
        var isDirty = false;
        function markDirty() { isDirty = true; }
        function markClean() { isDirty = false; localStorage.removeItem('cics_force_index'); }

        // Classe para Tela
        class Screen {
            constructor(name, content, id) {
                this.id = id || Date.now() + Math.random();
                this.name = name;
                this.content = content;
                this.fields = [];
                this.data = [];
                this.pfKeys = {}; // PFs definidos no TXT
                this.parseContent();
            }

            parseContent() {
                const lines = this.content.split('\n');
                this.data = [];
                this.fields = [];
                this.pfKeys = {};
                
                for (let row = 0; row < ROWS; row++) {
                    this.data[row] = [];
                    const line = lines[row] || '';
                    
                    for (let col = 0; col < COLS; col++) {
                        this.data[row][col] = line[col] || ' ';
                    }
                }

                // Parse de PFs em TODAS as linhas do arquivo
                // Formato esperado: PF1=LABEL ou ENTER=LABEL (múltiplos na mesma linha separados por espaço)
                // Suporta labels com espaços, hífens, underscores e outros caracteres
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    
                    // Buscar todos os PFx=LABEL na linha (captura até espaço duplo, vírgula ou fim da linha)
                    const pfMatches = line.matchAll(/PF(\d+)\s*=\s*([^,\s][^,]*?)(?=\s{2,}|\s*PF\d|\s*ENTER\s*=|\s*$)/gi);
                    for (const match of pfMatches) {
                        const pfNum = match[1];
                        const label = match[2].trim();
                        if (label) {
                            this.pfKeys[`PF${pfNum}`] = label;
                            console.log(`[PF Detection] PF${pfNum} = "${label}" na linha ${i + 1}`);
                        }
                    }
                    
                    // Buscar ENTER=LABEL na linha (captura até espaço duplo, vírgula ou fim da linha)
                    const enterMatch = line.match(/ENTER\s*=\s*([^,\s][^,]*?)(?=\s{2,}|\s*PF\d|\s*ENTER\s*=|\s*$)/i);
                    if (enterMatch) {
                        const label = enterMatch[1].trim();
                        if (label) {
                            this.pfKeys['ENTER'] = label;
                            console.log(`[PF Detection] ENTER = "${label}" na linha ${i + 1}`);
                        }
                    }
                }

                // PRIMEIRO: Adicionar campo de mensagem (linha 0, sempre existe)
                // attr byte em POS=(1,1), dados em cols 2-80 = 79 bytes
                const messageField = new Field(0, 0, 79, 'alpha', '');
                messageField.label = 'MENSAGEM';
                messageField.bmsVariable = 'MENSAGEM';
                this.fields.push(messageField);

                // Identificar campos editáveis e seus labels
                for (let row = 0; row < ROWS; row++) {
                    let col = 0;
                    while (col < COLS) {
                        const char = this.data[row][col];
                        
                        if (char === 'x' || char === 'z') {
                            let fieldLength = 0;
                            const fieldType = char === 'x' ? 'numeric' : 'alpha';
                            const startCol = col;
                            // Limite BMS: attr em startCol+1(1-idx), dados em startCol+2..80
                            // => max dados = 79 - startCol
                            const maxBMSLength = 79 - startCol;
                            if (maxBMSLength <= 0) { col++; continue; }
                            
                            // Contar tamanho do campo
                            while (col < COLS && this.data[row][col] === char) {
                                fieldLength++;
                                this.data[row][col] = ' ';
                                col++;
                            }
                            fieldLength = Math.min(fieldLength, maxBMSLength);
                            
                            const field = new Field(row, startCol, fieldLength, fieldType);
                            
                            // Tentar encontrar o label (texto antes do campo na mesma linha)
                            let labelText = '';
                            let labelStart = startCol - 1;
                            
                            // Voltar até encontrar texto não-espaço
                            while (labelStart >= 0 && this.data[row][labelStart] === ' ') {
                                labelStart--;
                            }
                            
                            // Capturar o texto do label (até encontrar espaços ou início da linha)
                            if (labelStart >= 0) {
                                let labelEnd = labelStart;
                                while (labelStart > 0 && this.data[row][labelStart - 1] !== ' ') {
                                    labelStart--;
                                }
                                
                                for (let i = labelStart; i <= labelEnd; i++) {
                                    labelText += this.data[row][i];
                                }
                                
                                labelText = labelText.trim();
                                
                                // Remover ':' no final se existir
                                if (labelText.endsWith(':')) {
                                    labelText = labelText.slice(0, -1);
                                }
                                
                                if (labelText) {
                                    field.label = labelText;
                                    // Gerar variável BMS baseada no label
                                    field.bmsVariable = labelText.toUpperCase().replace(/[^A-Z0-9]/g, '') + 'I';
                                }
                            }
                            
                            this.fields.push(field);
                        } else {
                            col++;
                        }
                    }
                }

                // Garantir unicidade das variáveis BMS: sufixar duplicatas com 2, 3, ...
                const varCount = {};
                for (const f of this.fields) {
                    if (!f.bmsVariable) continue;
                    const base = f.bmsVariable.substring(0, 8).toUpperCase();
                    if (!(base in varCount)) {
                        varCount[base] = 1;
                        f.bmsVariable = base;
                    } else {
                        varCount[base]++;
                        const suffix = String(varCount[base]);
                        f.bmsVariable = base.substring(0, 8 - suffix.length) + suffix;
                    }
                }
            }
        }

        // Classe para Campo
        class Field {
            constructor(row, col, length, type, value = '') {
                this.row = row;
                this.col = col;
                this.length = length;
                this.type = type;
                this.value = value;
                this.originalValue = value;
                this.linkedField = null; // Para mapeamento entre telas
                this.label = ''; // Nome customizado do campo
                this.bmsVariable = ''; // Nome da variável BMS para exportação
                
                // Atributos BMS
                this.bmsAttributes = {
                    protection: null, // UNPROT, PROT
                    type: null, // NUM, NORM (tipo de variável)
                    intensity: null, // BRT, DRK
                    ic: false, // Insert Cursor
                    fset: false, // Field Set
                    askip: false // Auto-skip (de outros atributos)
                };
                
                // Validação customizada
                this.validationRules = [];
                this.errorMessage = '';
                this.isRequired = false;
            }

            addValidation(type, params, message) {
                this.validationRules.push({ type, params, message });
            }

            isValid() {
                // Limpar mensagem de erro anterior
                this.errorMessage = '';
                
                console.log(`[Validação] Campo "${this.label || 'sem label'}" | Valor: "${this.value}" | Regras: ${this.validationRules.length}`);
                
                // Verificação de campo obrigatório
                if (this.isRequired && !this.value.trim()) {
                    this.errorMessage = 'Campo obrigatório';
                    console.log('[Validação] ❌ Campo obrigatório vazio');
                    return false;
                }
                
                // Verificar se há regras que precisam validar campo vazio (notZeros, notSpaces)
                const hasEmptyValidation = this.validationRules.some(r => 
                    r.type === 'notZeros' || r.type === 'notSpaces'
                );
                
                // Se vazio e não obrigatório E não tem validação de vazio, é válido
                if (!this.value.trim() && !hasEmptyValidation) {
                    console.log('[Validação] ✅ Campo vazio mas não obrigatório (sem validação de vazio)');
                    return true;
                }
                
                // Validação de tipo básico (apenas se não estiver vazio)
                if (this.value.trim() && this.type === 'numeric' && !/^\d*$/.test(this.value)) {
                    this.errorMessage = 'Apenas números são permitidos';
                    console.log('[Validação] ❌ Tipo numérico inválido');
                    return false;
                }
                
                // Validações customizadas
                for (const rule of this.validationRules) {
                    console.log(`[Validação] Testando regra: ${rule.type}`);
                    if (!this.validateRule(rule)) {
                        this.errorMessage = rule.message;
                        console.log(`[Validação] ❌ Falhou na regra ${rule.type}: ${rule.message}`);
                        return false;
                    }
                }
                
                console.log('[Validação] ✅ Todas as validações passaram');
                return true;
            }
            
            validateRule(rule) {
                const value = this.value;
                
                switch (rule.type) {
                    case 'minLength':
                        return value.length >= rule.params;
                    
                    case 'maxLength':
                        return value.length <= rule.params;
                    
                    case 'exactLength':
                        return value.length === rule.params;
                    
                    case 'pattern':
                        return new RegExp(rule.params).test(value);
                    
                    case 'numeric':
                        return /^[0-9]+$/.test(value);
                    
                    case 'alpha':
                        return /^[a-zA-Z\s]+$/.test(value);
                    
                    case 'alphanumeric':
                        return /^[a-zA-Z0-9]+$/.test(value);
                    
                    case 'notZeros':
                        const trimmedValue = value.trim();
                        const isOnlyZeros = /^0+$/.test(trimmedValue);
                        console.log('[notZeros] Valor:', JSON.stringify(value), '| Trimmed:', JSON.stringify(trimmedValue), '| É só zeros?', isOnlyZeros, '| Resultado:', !isOnlyZeros);
                        return !isOnlyZeros;
                    
                    case 'notSpaces':
                        const hasContent = value.trim().length > 0;
                        console.log('[notSpaces] Valor:', JSON.stringify(value), '| Length:', value.length, '| Trimmed length:', value.trim().length, '| Tem conteúdo?', hasContent);
                        return hasContent;
                    
                    case 'email':
                        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
                    
                    case 'cpf':
                        return /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(value);
                    
                    case 'cnpj':
                        return /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/.test(value);
                    
                    case 'phone':
                        return /^\(?\d{2}\)?\s?\d{4,5}-?\d{4}$/.test(value);
                    
                    case 'date':
                        return /^\d{2}\/\d{2}\/\d{4}$/.test(value);
                    
                    case 'range':
                        const num = parseFloat(value);
                        return num >= rule.params.min && num <= rule.params.max;
                    
                    case 'custom':
                        return rule.params(value);
                    
                    default:
                        return true;
                }
            }

            clear() {
                this.value = '';
            }

            reset() {
                this.value = this.originalValue;
            }
        }

        // Inicialização
        function init() {
            /* Se veio de um refresh (beforeunload disparou), vai para index */
            if (localStorage.getItem('cics_force_index')) {
                localStorage.removeItem('cics_force_index');
                localStorage.removeItem('cics_current_project');
                window.location.replace('index.html');
                return;
            }
            /* Se não há projeto ativo, volta para o index */
            if (!localStorage.getItem('cics_current_project')) {
                window.location.replace('index.html');
                return;
            }
            initTerminal();
            setupEventListeners();
            updateTime();
            setInterval(updateTime, 1000);
            loadEditorState();
        }

        /* ══════════════════════════════════════════════════════════
           loadEditorState — reconstrói TUDO salvo em cics_editor_state
           (telas, campos + validações + atributos, regras de navegação,
            validationKeys, dataMapping)
        ══════════════════════════════════════════════════════════ */
        function loadEditorState() {
            var raw = '';
            try { raw = localStorage.getItem('cics_editor_state') || ''; } catch(e) {}
            if (!raw) return;

            var state;
            try { state = JSON.parse(raw); } catch(e) { return; }
            if (!state || !Array.isArray(state.screens) || state.screens.length === 0) return;

            /* ── Reconstrói cada tela ── */
            app.screens = state.screens.map(function(sd) {
                /* Cria a Screen com o conteúdo salvo (parseContent rodará normalmente) */
                var screen = new Screen(sd.name, sd.content || '', sd.id);

                /* Sobrescreve os campos com os dados salvos (incluem validações, labels, etc.) */
                if (Array.isArray(sd.fields)) {
                    screen.fields = sd.fields.map(function(fd) {
                        var f = new Field(fd.row, fd.col, fd.length, fd.type, fd.value || '');
                        f.originalValue = fd.originalValue !== undefined ? fd.originalValue : (fd.value || '');
                        f.label         = fd.label        || '';
                        f.bmsVariable   = fd.bmsVariable  || '';
                        f.linkedField   = fd.linkedField  || null;
                        f.isRequired    = fd.isRequired   || false;
                        f.errorMessage  = fd.errorMessage || '';
                        f.validationRules = Array.isArray(fd.validationRules) ? fd.validationRules : [];
                        if (fd.bmsAttributes && typeof fd.bmsAttributes === 'object') {
                            f.bmsAttributes = {
                                protection: fd.bmsAttributes.protection || null,
                                type:       fd.bmsAttributes.type       || null,
                                intensity:  fd.bmsAttributes.intensity  || null,
                                ic:         fd.bmsAttributes.ic         || false,
                                fset:       fd.bmsAttributes.fset       || false,
                                askip:      fd.bmsAttributes.askip      || false
                            };
                        }
                        return f;
                    });
                }

                /* Sobrescreve os pfKeys salvos */
                if (sd.pfKeys && typeof sd.pfKeys === 'object') {
                    screen.pfKeys = sd.pfKeys;
                }

                /* Restaurar metadados de import BMS */
                if (sd.bmsImported) screen.bmsImported = true;
                if (sd.bmsSource)   screen.bmsSource   = sd.bmsSource;
                if (sd._bmsHeader)  screen._bmsHeader  = sd._bmsHeader;

                return screen;
            });

            /* ── Restaura regras de navegação ── */
            app.navigationRules = Array.isArray(state.navigationRules) ? state.navigationRules : [];

            /* ── Restaura configurações globais ── */
            if (Array.isArray(state.validationKeys))    app.validationKeys = state.validationKeys;
            if (state.dataMapping && typeof state.dataMapping === 'object') app.dataMapping = state.dataMapping;

            /* ── Renderiza lista de telas e carrega a primeira ── */
            app.currentScreenIndex = -1;
            updateScreensList();
            if (app.screens.length > 0) {
                loadScreen(0);
            }
        }

        function initTerminal() {
            const terminal = document.getElementById('terminal');
            terminal.innerHTML = '<div class="cursor" id="cursor"></div>';
            
            // Criar grid vazio
            for (let row = 0; row < ROWS; row++) {
                const lineDiv = document.createElement('div');
                lineDiv.className = 'screen-line';
                
                for (let col = 0; col < COLS; col++) {
                    const charSpan = document.createElement('span');
                    charSpan.className = 'screen-char protected';
                    charSpan.dataset.row = row;
                    charSpan.dataset.col = col;
                    charSpan.textContent = ' ';
                    lineDiv.appendChild(charSpan);
                }
                
                terminal.appendChild(lineDiv);
            }
        }

        // ─── MOBILE TERMINAL INPUT ───
        function _setupMobileInput() {
            var inp = document.getElementById('mobileTerminalInput');
            if (!inp) return;

            // Rota input do teclado virtual para o terminal
            inp.addEventListener('input', function(e) {
                if (app.currentScreenIndex < 0 || app.fields.length === 0) return;
                var field = app.fields[app.currentFieldIndex];
                if (!field || field.label === 'MENSAGEM' || field.row === 0) return;

                var typed = inp.value;
                inp.value = '';          // limpa buffer imediatamente

                for (var i = 0; i < typed.length; i++) {
                    var ch = typed[i];
                    if (field.type === 'numeric' && !/\d/.test(ch)) {
                        showMessage('Este campo aceita apenas números!', 'error');
                        animateFieldError(field);
                        continue;
                    }
                    var pos = app.cursorCol - field.col;
                    if (field.value.length < field.length) {
                        field.value = field.value.slice(0, pos) + ch + field.value.slice(pos);
                        if (app.cursorCol < field.col + field.length - 1) app.cursorCol++;
                    }
                }
                updateCursorPosition();
                renderCurrentScreen();
            });

            inp.addEventListener('keydown', function(e) {
                if (e.key === 'Backspace') {
                    e.preventDefault();
                    if (app.currentScreenIndex < 0 || app.fields.length === 0) return;
                    var field = app.fields[app.currentFieldIndex];
                    if (!field || field.label === 'MENSAGEM' || field.row === 0) return;
                    var pos = app.cursorCol - field.col;
                    if (pos > 0) {
                        field.value = field.value.slice(0, pos - 1) + field.value.slice(pos);
                        app.cursorCol--;
                        updateCursorPosition();
                        renderCurrentScreen();
                    }
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    inp.blur();
                    handleKeyPress(e);
                } else if (e.key === 'Tab') {
                    e.preventDefault();
                    mobileNextField();
                }
            });

            // Tap no terminal: detecta campo e foca
            var terminal = document.getElementById('terminal');
            if (terminal) {
                terminal.addEventListener('click', function(e) {
                    var cell = e.target.closest('[data-row][data-col]');
                    if (!cell) return;
                    var row = parseInt(cell.dataset.row);
                    var col = parseInt(cell.dataset.col);
                    var fieldIdx = app.fields.findIndex(function(f) {
                        return f.row === row && col >= f.col && col < f.col + f.length;
                    });
                    if (fieldIdx >= 0) {
                        focusField(fieldIdx);
                        if (window.innerWidth <= 767) {
                            var mi = document.getElementById('mobileTerminalInput');
                            if (mi) { mi.focus(); }
                        }
                    }
                });
            }
        }

        function mobileNextField() {
            if (app.fields.length === 0) return;
            focusField((app.currentFieldIndex + 1) % app.fields.length);
            var mi = document.getElementById('mobileTerminalInput');
            if (mi) mi.focus();
        }
        function mobilePrevField() {
            if (app.fields.length === 0) return;
            focusField((app.currentFieldIndex - 1 + app.fields.length) % app.fields.length);
            var mi = document.getElementById('mobileTerminalInput');
            if (mi) mi.focus();
        }
        function mobileClearField() {
            if (app.fields.length === 0) return;
            var field = app.fields[app.currentFieldIndex];
            if (!field || field.label === 'MENSAGEM' || field.row === 0) return;
            field.value = '';
            app.cursorCol = field.col;
            updateCursorPosition();
            renderCurrentScreen();
        }

        // Configurar Event Listeners
        function setupEventListeners() {
            // Drag and drop
            const dropZone = document.getElementById('dropZone');
            dropZone.addEventListener('dragover', handleDragOver);
            dropZone.addEventListener('drop', handleDrop);
            dropZone.addEventListener('dragleave', handleDragLeave);
            
            // Input de arquivo
            document.getElementById('fileInput').addEventListener('change', handleFileSelect);

            // Mobile input (teclado virtual + tap no terminal)
            _setupMobileInput();
            
            // Teclado
            document.addEventListener('keydown', handleKeyPress);
            
            // Teclas de função
            document.querySelectorAll('.function-key').forEach(key => {
                key.addEventListener('click', handleFunctionKey);
            });
            
            // Impedir que eventos do painel de validação afetem o terminal
            const validationPanel = document.getElementById('validationPanel');
            if (validationPanel) {
                // Impedir propagação de eventos de teclado
                validationPanel.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                });
                
                validationPanel.addEventListener('keyup', (e) => {
                    e.stopPropagation();
                });
                
                validationPanel.addEventListener('keypress', (e) => {
                    e.stopPropagation();
                });
                
                // Impedir que cliques em inputs/selects mudem foco para terminal
                validationPanel.addEventListener('click', (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
                        e.stopPropagation();
                    }
                });
            }

            // Event listeners para importação de regras
            const importInput = document.getElementById('importFileInput');
            if (importInput) {
                importInput.removeEventListener('change', handleImportFile); // Remove anterior se existir
                importInput.addEventListener('change', handleImportFile);
            }

            /* ── Proteção contra refresh sem salvar ── */
            window.addEventListener('beforeunload', function(e) {
                /* Sempre marca para redirecionar ao index no próximo carregamento */
                localStorage.setItem('cics_force_index', '1');
                if (isDirty) {
                    /* Exibe dialogo nativo do navegador */
                    e.preventDefault();
                    e.returnValue = '';
                }
            });
            /* Se o usuário cancelou o dialogo, a janela volta ao foco: limpa o flag */
            window.addEventListener('focus', function() {
                localStorage.removeItem('cics_force_index');
            });

            const importDropZone = document.getElementById('importDropZone');
            if (importDropZone) {
                importDropZone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.currentTarget.classList.add('dragover');
                });

                importDropZone.addEventListener('dragleave', (e) => {
                    e.currentTarget.classList.remove('dragover');
                });

                importDropZone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.currentTarget.classList.remove('dragover');
                    const file = e.dataTransfer.files[0];
                    if (file) {
                        processImportFile(file);
                    }
                });
            }
        }

        // Gerenciamento de Arquivos
        function openFileModal() {
            document.getElementById('fileModalOverlay').classList.add('show');
            app.pendingFiles = [];
            updateFileList();
        }

        function closeFileModal() {
            document.getElementById('fileModalOverlay').classList.remove('show');
            app.pendingFiles = [];
        }

        function openNewScreenModal() {
            // Fechar drawers mobile antes de abrir o modal
            closeMobileDrawers();
            document.getElementById('newScreenNameInput').value = '';
            document.getElementById('newScreenModalOverlay').classList.add('show');
            setTimeout(() => document.getElementById('newScreenNameInput').focus(), 100);
        }

        function closeNewScreenModal() {
            document.getElementById('newScreenModalOverlay').classList.remove('show');
        }

        function createBlankScreen() {
            const raw = document.getElementById('newScreenNameInput').value.trim().toUpperCase();
            if (!raw) {
                showMessage('Informe um nome para a tela!', 'error');
                return;
            }
            // Substituir espaços e caracteres inválidos por _
            const name = raw.replace(/[^A-Z0-9_\-]/g, '_').substring(0, 8);
            // Verificar nome duplicado
            if (app.screens.some(s => s.name.toUpperCase() === name)) {
                showMessage(`Já existe uma tela chamada "${name}"!`, 'error');
                return;
            }
            const screen = new Screen(name, '');
            app.screens.push(screen);
            markDirty();
            updateScreensList();
            closeNewScreenModal();
            loadScreen(app.screens.length - 1);
            // Abrir editor de layout automaticamente para o usuário desenhar a tela
            openScreenEditor();
        }

        function selectFiles() {
            document.getElementById('fileInput').click();
        }

        function handleFileSelect(e) {
            const files = Array.from(e.target.files);
            files.forEach(file => {
                if (file.type === 'text/plain' || file.name.endsWith('.txt') || file.name.endsWith('.bms')) {
                    app.pendingFiles.push(file);
                }
            });
            updateFileList();
        }

        function handleDragOver(e) {
            e.preventDefault();
            e.currentTarget.classList.add('dragover');
        }

        function handleDragLeave(e) {
            e.currentTarget.classList.remove('dragover');
        }

        function handleDrop(e) {
            e.preventDefault();
            e.currentTarget.classList.remove('dragover');
            
            const files = Array.from(e.dataTransfer.files);
            files.forEach(file => {
                if (file.type === 'text/plain' || file.name.endsWith('.txt') || file.name.endsWith('.bms')) {
                    app.pendingFiles.push(file);
                }
            });
            updateFileList();
        }

        function updateFileList() {
            const fileList = document.getElementById('fileList');
            
            if (app.pendingFiles.length === 0) {
                fileList.innerHTML = '<div style="text-align: center; opacity: 0.5;">Nenhum arquivo selecionado</div>';
                return;
            }
            
            fileList.innerHTML = app.pendingFiles.map((file, index) => `
                <div class="file-item">
                    <span class="file-item-name">${file.name}</span>
                    <span class="file-item-status">Pronto</span>
                </div>
            `).join('');
        }

        async function loadSelectedFiles() {
            if (app.pendingFiles.length === 0) {
                showMessage('Nenhum arquivo selecionado!', 'error');
                return;
            }
            
            showLoader();
            
            let totalRulesCreated = 0;
            
            for (const file of app.pendingFiles) {
                const content = await readFile(file);
                
                // Detectar se é um arquivo BMS
                if (isBMSFile(content)) {
                    // Processar arquivo BMS — pode retornar várias telas (um DFHMDI = uma tela)
                    const bmsScreens = parseBMSToScreen(content, file.name);
                    if (bmsScreens && bmsScreens.length > 0) {
                        for (const screen of bmsScreens) {
                            app.screens.push(screen);
                        }
                        const msg = bmsScreens.length === 1
                            ? `Tela importada de: ${file.name}`
                            : `${bmsScreens.length} telas importadas de: ${file.name}`;
                        showMessage(msg, 'success');
                    }
                } else {
                    // Processar como arquivo de texto normal (3270)
                    const screenName = file.name.replace('.txt', '');
                    const screen = new Screen(screenName, content);
                    app.screens.push(screen);
                    
                    // Criar regras de navegação automaticamente APENAS para PF keys encontradas no TXT
                    if (screen.pfKeys && Object.keys(screen.pfKeys).length > 0) {
                        for (const [key, label] of Object.entries(screen.pfKeys)) {
                            // Verificar se já existe regra para esta tela + tecla
                            const existingRule = app.navigationRules.find(r => 
                                r.fromScreen === screen.id && r.key === key
                            );
                            
                            if (!existingRule) {
                                // Criar nova regra apenas com fromScreen e key preenchidos
                                app.navigationRules.push({
                                    id: Date.now() + Math.random(),
                                    fromScreen: screen.id,
                                    toScreen: null,
                                    key: key,
                                    action: 'navigate',
                                    message: '',
                                    label: label // Guardar o label original do TXT
                                });
                                totalRulesCreated++;
                            }
                        }
                    }
                }
            }
            
            updateScreensList();
            closeFileModal();
            hideLoader();
            
            if (app.screens.length > 0 && app.currentScreenIndex === -1) {
                loadScreen(0);
            }
            
            markDirty();
            if (totalRulesCreated > 0) {
                showMessage(`${app.pendingFiles.length} tela(s) carregadas com ${totalRulesCreated} regra(s) criadas!`, 'success');
            } else {
                showMessage(`${app.pendingFiles.length} tela(s) carregadas com sucesso!`, 'success');
            }
            
            app.pendingFiles = [];
            // Resetar o input de arquivo para permitir recarregar o mesmo arquivo
            const fileInput = document.getElementById('fileInput');
            if (fileInput) {
                fileInput.value = '';
            }
        }

        // Detectar se o arquivo é um BMS
        function isBMSFile(content) {
            return content.includes('DFHMSD') || content.includes('DFHMDI') || content.includes('DFHMDF');
        }

        // Parsear arquivo BMS e criar Screen(s) — retorna array (um DFHMDI = uma tela)
        function parseBMSToScreen(bmsContent, fileName) {
            try {
                const fileBaseName = fileName.replace(/\.[^.]+$/, '');
                const screens = [];
                let currentScreen = null;
                let pfKeysFound = {};

                // Finalizar tela atual: criar regras de navegação e empurrar para o array
                const flushScreen = () => {
                    if (!currentScreen) return;
                    currentScreen.pfKeys = pfKeysFound;
                    // Salvar source bruto: header DFHMSD + bloco DFHMDI atual
                    const blockSrc = [...headerLines, ...rawBlockLines].join('\n');
                    currentScreen.bmsSource = blockSrc || null;
                    currentScreen.bmsImported = true; // marcador: veio de arquivo BMS
                    // Salvar o bloco DFHMSD+DFHMDI original para regeneração após edição
                    // Extrair só as linhas até (e incluindo) o DFHMDI
                    const allHdrLines = [...headerLines, ...rawBlockLines];
                    const dfhmdiIdx = allHdrLines.findIndex(l => /DFHMDI/i.test(l));
                    currentScreen._bmsHeader = dfhmdiIdx >= 0
                        ? allHdrLines.slice(0, dfhmdiIdx + 1).join('\n') + '\n*'
                        : null;
                    for (const [key, label] of Object.entries(pfKeysFound)) {
                        const existingRule = app.navigationRules.find(r =>
                            r.fromScreen === currentScreen.id && r.key === key
                        );
                        if (!existingRule) {
                            app.navigationRules.push({
                                id: Date.now() + Math.random(),
                                fromScreen: currentScreen.id,
                                toScreen: null,
                                key: key,
                                action: 'navigate',
                                message: '',
                                label: label
                            });
                        }
                    }
                    screens.push(currentScreen);
                    currentScreen = null;
                    pfKeysFound = {};
                    rawBlockLines = [];
                };

                // Parsear BMS linha por linha
                const lines = bmsContent.split('\n');
                let currentLine = '';
                const headerLines = [];  // linhas DFHMSD antes do primeiro DFHMDI
                let rawBlockLines = [];  // linhas brutas do bloco DFHMDI atual
                
                for (let i = 0; i < lines.length; i++) {
                    let line = lines[i].replace(/\r$/, ''); // Remover \r do Windows
                    
                    // Acumular linha bruta no bloco corrente (antes de filtrar)
                    if (currentScreen) {
                        rawBlockLines.push(line);
                    } else {
                        headerLines.push(line);
                    }

                    // Ignorar linhas de comentário (col 1 = '*') e linhas vazias
                    if (line.trim() === '' || line[0] === '*') { currentLine = ''; continue; }
                    
                    // Detectar tipo de continuação antes de acumular
                    const isStringCont = /INITIAL='[^']*$/.test(currentLine); // literal de string ainda aberto
                    const hasColCont   = line.length > 71 && line.charAt(71) !== ' '; // qualquer char não-branco em col 72

                    // Acumular conforme o tipo:
                    if (isStringCont) {
                        // Continuação de literal: strip indentação inicial (colunas 1-15 em assembler)
                        // e não incluir o marcador de col 72 se houver
                        currentLine += line.substring(0, hasColCont ? 71 : 72).replace(/^\s+/, '');
                    } else if (hasColCont) {
                        // Col 72 preenchida: não incluir o marcador de continuação no conteúdo
                        currentLine += line.substring(0, 71).trimEnd();
                    } else {
                        currentLine += line.substring(0, 72).trimEnd();
                    }

                    // Continuação: col 72, vírgula final, ou literal de string ainda aberto
                    const isContinuation = hasColCont
                        || currentLine.trimEnd().endsWith(',')
                        || /INITIAL='[^']*$/.test(currentLine);
                    if (isContinuation) continue;
                    
                    const fullLine = currentLine;
                    currentLine = '';

                    // DFHMDI → nova tela
                    if (fullLine.includes('DFHMDI')) {
                        flushScreen(); // salvar tela anterior
                        const mapNameMatch = fullLine.match(/^(\w{1,8})\s+DFHMDI/i);
                        const mapName = mapNameMatch ? mapNameMatch[1] : `${fileBaseName}_${screens.length + 1}`;
                        currentScreen = new Screen(mapName, '');
                        currentScreen.outputFields = [];
                        rawBlockLines = [];
                        // A linha DFHMDI foi adicionada em headerLines (pois currentScreen era null antes)
                        // Movê-la para rawBlockLines
                        const dfhmdiRaw = headerLines.pop();
                        if (dfhmdiRaw !== undefined) rawBlockLines.push(dfhmdiRaw);
                        continue;
                    }

                    // DFHMSD TYPE=FINAL → encerra
                    if (fullLine.includes('DFHMSD')) continue;

                    // Processar linha completa
                    if (fullLine.includes('DFHMDF')) {
                        // BMS sem DFHMDI: criar tela pelo nome do arquivo
                        if (!currentScreen) {
                            currentScreen = new Screen(fileBaseName, '');
                            currentScreen.outputFields = [];
                        }
                        const field = parseDFHMDFLine(fullLine);
                        if (field) {
                            // Se tem INITIAL, é um label estático
                            if (field.initial) {
                                // Adicionar texto estático na tela
                                for (let col = 0; col < field.initial.length; col++) {
                                    if (field.row < 24 && field.col + col < 80) {
                                        currentScreen.data[field.row][field.col + col] = field.initial[col];
                                    }
                                }
                                
                                // Detectar PF keys no INITIAL
                                const text = field.initial;
                                
                                // Padrão 1: PF3=SAIR
                                const matches1 = text.matchAll(/PF(\d+)\s*=\s*([^,\s][^,]*?)(?=\s{2,}|\s*PF\d|\s*ENTER\s*=|\s*$)/gi);
                                for (const match of matches1) {
                                    const label = match[2].trim();
                                    if (label) pfKeysFound[`PF${match[1]}`] = label;
                                }
                                
                                // Padrão 2: ENTER=CONFIRMAR
                                const enterMatch = text.match(/ENTER\s*=\s*([^,\s][^,]*?)(?=\s{2,}|\s*PF\d|\s*ENTER\s*=|\s*$)/i);
                                if (enterMatch) {
                                    const label = enterMatch[1].trim();
                                    if (label) pfKeysFound['ENTER'] = label;
                                }
                                
                                // Padrão 3: PF7/PF8=NAVEGAR
                                const matches2 = text.matchAll(/PF(\d+)(?:\/PF(\d+))+=([\w\s-]+)/gi);
                                for (const match of matches2) {
                                    const pfNumbers = match[0].match(/PF(\d+)/gi);
                                    const label = match[match.length - 1].trim();
                                    if (pfNumbers && label) {
                                        pfNumbers.forEach(pf => {
                                            pfKeysFound[`PF${pf.match(/PF(\d+)/i)[1]}`] = label;
                                        });
                                    }
                                }
                            }
                            // Se tem LENGTH > 0 e é UNPROT, é campo editável
                            else if (field.length > 0 && field.attrb.includes('UNPROT')) {
                                const fieldType = field.attrb.includes('NUM') ? 'numeric' : 'alpha';
                                const newField = new Field(field.row, field.col, field.length, fieldType, '');
                                
                                // Configurar atributos BMS do campo
                                if (field.attrb.includes('UNPROT')) newField.bmsAttributes.protection = 'UNPROT';
                                if (field.attrb.includes('PROT')) newField.bmsAttributes.protection = 'PROT';
                                if (field.attrb.includes('NUM')) newField.bmsAttributes.type = 'NUM';
                                if (field.attrb.includes('NORM')) newField.bmsAttributes.type = 'NORM';
                                if (field.attrb.includes('BRT')) newField.bmsAttributes.intensity = 'BRT';
                                if (field.attrb.includes('DRK')) newField.bmsAttributes.intensity = 'DRK';
                                if (field.attrb.includes('IC')) newField.bmsAttributes.ic = true;
                                if (field.attrb.includes('FSET')) newField.bmsAttributes.fset = true;
                                if (field.attrb.includes('ASKIP')) newField.bmsAttributes.askip = true;
                                
                                // Adicionar nome da variável BMS se houver
                                if (field.name) {
                                    newField.bmsVariable = field.name;
                                    newField.label = field.name;
                                }
                                
                                currentScreen.fields.push(newField);
                            }
                            // Se tem LENGTH > 0 e é PROT sem INITIAL, é área de saída (preenchida pelo COBOL)
                            else if (field.length > 0 && !field.attrb.includes('ASKIP')) {
                                currentScreen.outputFields.push({
                                    row:    field.row,
                                    col:    field.col,
                                    length: field.length,
                                    name:   field.name || null,
                                    bright: field.attrb.includes('BRT')
                                });
                            }
                        }
                    }
                }
                
                flushScreen(); // salvar última tela
                
                return screens;
            } catch (error) {
                console.error('Erro ao parsear BMS:', error);
                showMessage('Erro ao importar arquivo BMS: ' + error.message, 'error');
                return [];
            }
        }

        // Parsear uma linha DFHMDF
        function parseDFHMDFLine(line) {
            const field = {
                name: null,
                row: 0,
                col: 0,
                length: 0,
                attrb: '',
                initial: null
            };
            
            // Extrair nome do campo (primeiras 6-7 colunas antes de DFHMDF)
            const nameMatch = line.match(/^(\w+)\s+DFHMDF/);
            if (nameMatch) {
                field.name = nameMatch[1].trim();
            }
            
            // Extrair POS=(row,col)
            const posMatch = line.match(/POS=\((\d+),(\d+)\)/);
            if (posMatch) {
                field.row = parseInt(posMatch[1]) - 1; // BMS usa 1-based, convertemos para 0-based
                field.col = parseInt(posMatch[2]) - 1;
            }
            
            // Extrair LENGTH
            const lengthMatch = line.match(/LENGTH=(\d+)/);
            if (lengthMatch) {
                field.length = parseInt(lengthMatch[1]);
            }
            
            // Extrair ATTRB
            const attrbMatch = line.match(/ATTRB=(\([^)]+\)|[A-Z]+)/);
            if (attrbMatch) {
                field.attrb = attrbMatch[1].replace(/[()]/g, '');
            }
            
            // Extrair INITIAL
            const initialMatch = line.match(/INITIAL='([^']*)'/);
            if (initialMatch) {
                field.initial = initialMatch[1];
            } else {
                // Tentar capturar INITIAL sem aspa de fechamento (linha quebrada)
                const initialMatch2 = line.match(/INITIAL='(.+)$/);
                if (initialMatch2) {
                    field.initial = initialMatch2[1].trim();
                }
            }
            
            return field;
        }

        function readFile(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.onerror = reject;
                reader.readAsText(file);
            });
        }

        // Gerenciamento de Telas
        function updateScreensList() {
            const container = document.getElementById('screensContainer');
            const count = document.getElementById('screenCount');
            
            count.textContent = `${app.screens.length} tela(s)`;
            
            if (app.screens.length === 0) {
                container.innerHTML = '<div style="text-align: center; opacity: 0.5; padding: 20px;">Nenhuma tela carregada</div>';
                renderNavigationRules();
                return;
            }
            
            container.innerHTML = app.screens.map((screen, index) => `
                <div class="screen-item ${index === app.currentScreenIndex ? 'active' : ''}" 
                     onclick="if(event.target.closest('.screen-action-btn'))return; loadScreen(${index})">
                    <span class="screen-item-name">${screen.name}</span>
                    ${screen.fields.length > 0 ? 
                        `<span class="screen-item-badge">${screen.fields.length} campos</span>` : ''}
                    <div class="screen-item-actions">
                        <button class="screen-action-btn delete" onclick="event.stopPropagation(); deleteScreen(${index})">🗑️</button>
                    </div>
                </div>
            `).join('');
            
            document.getElementById('totalScreens').textContent = app.screens.length;
            renderNavigationRules();
        }

        function loadScreen(index) {
            if (index < 0 || index >= app.screens.length) return;

            // Bloquear troca de tela enquanto o editor de layout estiver aberto
            if (app.editMode) {
                showMessage('Feche o editor (\u2705 Fechar Edi\u00e7\u00e3o) antes de trocar de tela.', 'error');
                return;
            }
            if (app.currentScreenIndex >= 0) {
                saveCurrentScreenData();
            }
            
            app.currentScreenIndex = index;
            const screen = app.screens[index];
            app.fields = screen.fields;
            app.currentFieldIndex = 0;
            
            renderScreen(screen);
            updateScreensList();
            updateScreenInfo();
            updatePFKeysLabels();
            
            // Atualizar lista de campos no painel de validação
            selectedFieldIndex = -1;
            _highlightPanelField(-1);
            if (!document.getElementById('validationPanel').classList.contains('collapsed')) {
                renderFieldsList();
                renderFieldConfig();
            }
            
            if (app.fields.length > 0) {
                focusField(0);
            }

            // Atualizar painel de código e contagem IDE
            updateScreenFieldsCount();
            updateCodePanel();

            // Verificar se existe regra ONLOAD para esta tela
            setTimeout(() => {
                const onloadRules = app.navigationRules.filter(r => 
                    r.fromScreen === screen.id && r.key === 'ONLOAD'
                );
                
                if (onloadRules.length > 0) {
                    // Executar regras ONLOAD
                    onloadRules.forEach(rule => {
                        if (rule.action === 'message' && rule.message) {
                            displayMessageOnFirstLine(rule.message);
                        } else if (rule.action === 'navigate_msg' && rule.message) {
                            displayMessageOnFirstLine(rule.message);
                        } else if (rule.action === 'navigate') {
                            // ONLOAD com navigate não faz sentido, ignorar
                        }
                    });
                } else {
                    displayMessageOnFirstLine(`Tela "${screen.name}" carregada`);
                }
            }, 50);
        }

        function renderScreen(screen) {
            const terminal = document.getElementById('terminal');
            const lines = terminal.querySelectorAll('.screen-line');
            
            lines.forEach((line, row) => {
                const chars = line.querySelectorAll('.screen-char');
                chars.forEach((char, col) => {
                    char.className = 'screen-char';
                    
                    // Primeira linha é sempre campo de mensagem (branco)
                    if (row === 0) {
                        char.classList.add('message-line');
                        char.textContent = screen.data[row][col];
                        return;
                    }
                    
                    char.textContent = screen.data[row][col];
                    
                    // Verificar se está em um campo editável
                    const field = screen.fields.find(f => 
                        f.row === row && col >= f.col && col < f.col + f.length
                    );
                    
                    if (field) {
                        char.classList.add(field.type === 'numeric' ? 'numeric' : 'unprotected');
                        const fieldOffset = col - field.col;
                        // Mostrar '_' quando vazio (comportamento padrão 3270)
                        char.textContent = field.value[fieldOffset] || '_';
                    } else {
                        // Verificar se está em um campo de saída PROT (sem INITIAL)
                        const outField = screen.outputFields && screen.outputFields.find(f =>
                            f.row === row && col >= f.col && col < f.col + f.length
                        );
                        if (outField) {
                            char.classList.add(outField.bright ? 'prot-output-brt' : 'prot-output');
                            // Campo de saída: vazio (preenchido pelo COBOL em runtime)
                            char.textContent = '_';
                        } else if (screen.data[row][col] !== ' ') {
                            char.classList.add('protected');
                        }
                    }
                });
            });
        }

        function saveCurrentScreenData() {
            // Salvar valores dos campos da tela atual
            const screen = app.screens[app.currentScreenIndex];
            if (screen) {
                screen.fields = app.fields;
            }
        }

        function deleteScreen(index) {
            if (app.editMode) {
                showMessage('Feche o editor antes de remover uma tela.', 'error');
                return;
            }
            if (confirm(`Remover a tela "${app.screens[index].name}"?`)) {
                const deletedScreenId = app.screens[index].id;
                
                // Remover regras de navegação associadas a esta tela
                app.navigationRules = app.navigationRules.filter(r => 
                    r.fromScreen !== deletedScreenId && r.toScreen !== deletedScreenId
                );
                
                app.screens.splice(index, 1);
                markDirty();
                
                if (app.currentScreenIndex === index) {
                    // Se deletou a tela ativa, carregar outra se houver
                    if (app.screens.length > 0) {
                        // Carregar a tela anterior ou a primeira disponível
                        const newIndex = index > 0 ? index - 1 : 0;
                        app.currentScreenIndex = -1; // Reset temporário
                        loadScreen(newIndex);
                    } else {
                        // Não há mais telas
                        app.currentScreenIndex = -1;
                        app.fields = [];
                        initTerminal();
                    }
                } else if (app.currentScreenIndex > index) {
                    app.currentScreenIndex--;
                }
                
                updateScreensList();
                updateScreenInfo();
                showMessage('Tela removida', 'success');
            }
        }

        // Navegação
        function nextScreen() {
            if (app.screens.length === 0) return;
            
            const nextIndex = (app.currentScreenIndex + 1) % app.screens.length;
            loadScreen(nextIndex);
        }

        function prevScreen() {
            if (app.screens.length === 0) return;
            
            const prevIndex = (app.currentScreenIndex - 1 + app.screens.length) % app.screens.length;
            loadScreen(prevIndex);
        }

        function addNavigationRule() {
            if (app.screens.length < 1) {
                showMessage('Carregue pelo menos 1 tela para criar regras', 'error');
                return;
            }

            // Buscar uma tecla que ainda não está sendo usada na tela atual
            const currentScreen = app.screens[app.currentScreenIndex >= 0 ? app.currentScreenIndex : 0];
            const allKeys = ['ONLOAD', 'ENTER', 'PF1', 'PF2', 'PF3', 'PF4', 'PF5', 'PF6', 'PF7', 'PF8', 'PF9', 'PF10', 'PF11', 'PF12'];
            const usedKeys = app.navigationRules
                .filter(r => r.fromScreen === currentScreen.id)
                .map(r => r.key);
            
            const availableKey = allKeys.find(k => !usedKeys.includes(k)) || 'PF1';

            // Determinar ação padrão
            let defaultAction = 'navigate';

            const rule = {
                id: Date.now(),
                fromScreen: currentScreen.id,
                toScreen: app.screens.length > 1 ? app.screens.find(s => s.id !== currentScreen.id).id : currentScreen.id,
                key: availableKey,
                action: defaultAction,
                message: ''
            };

            app.navigationRules.push(rule);
            markDirty();
            renderNavigationRules();
            updatePFKeysLabels();
            if ((app.activeCodeTab || 'cics') === 'cics') updateCodePanel(true);
        }

        function renderNavigationRules() {
            const navMapping = document.getElementById('navMapping');
            const rulesCount = document.getElementById('rulesCount');
            
            // Atualizar contador e mostrar botão de associação se necessário
            const unmappedCount = app.navigationRules.filter(r => r.needsMapping).length;
            rulesCount.innerHTML = `${app.navigationRules.length} regra(s)`;
            
            if (unmappedCount > 0) {
                rulesCount.innerHTML += ` <button onclick="openMappingModal()" style="padding: 3px 8px; background: #663300; color: #ff9800; border: 1px solid #ff9800; cursor: pointer; font-size: 10px; border-radius: 3px; margin-left: 5px;">⚠️ ${unmappedCount} sem associação</button>`;
            }
            
            if (app.navigationRules.length === 0) {
                navMapping.innerHTML = '<div style="text-align: center; opacity: 0.5; padding: 20px;">Nenhuma regra de navegação configurada</div>';
                return;
            }

            navMapping.innerHTML = app.navigationRules.map(rule => {
                const fromScreen = app.screens.find(s => s.id === rule.fromScreen);
                const toScreen = app.screens.find(s => s.id === rule.toScreen);
                const action = rule.action || 'navigate';
                const needsMapping = rule.needsMapping;

                return `
                    <div class="nav-rule${needsMapping ? ' nav-rule-warn' : ''}">
                        <div class="nav-row1">
                            ${needsMapping ? '<span class="nav-warn-icon" title="Precisa de associação">⚠️</span>' : ''}
                            <span class="nav-lbl">De:</span>
                            <select class="nav-sel" onchange="updateNavigationRule(${rule.id}, 'fromScreen', this.value)">
                                ${!fromScreen ? `<option value="">⚠️ ${rule.originalFromScreenName || 'Selecione'}</option>` : ''}
                                ${app.screens.map(s => `<option value="${s.id}" ${s.id === rule.fromScreen ? 'selected' : ''}>${s.name}</option>`).join('')}
                            </select>
                            <select class="nav-sel nav-sel-key" onchange="updateNavigationRule(${rule.id}, 'key', this.value)">
                                <option value="ONLOAD" ${rule.key === 'ONLOAD' ? 'selected' : ''}>🔄 Load</option>
                                <option value="ENTER"  ${rule.key === 'ENTER'  ? 'selected' : ''}>ENTER</option>
                                ${[1,2,3,4,5,6,7,8,9,10,11,12].map(n => `<option value="PF${n}" ${rule.key === 'PF'+n ? 'selected' : ''}>PF${n}</option>`).join('')}
                            </select>
                        </div>
                        <div class="nav-row2">
                            <select class="nav-sel nav-sel-action" onchange="updateNavigationRule(${rule.id}, 'action', this.value)">
                                <option value="navigate"     ${action === 'navigate'     ? 'selected' : ''}>→ Navegar</option>
                                <option value="navigate_msg" ${action === 'navigate_msg' ? 'selected' : ''}>→ Nav+Msg</option>
                                <option value="message"      ${action === 'message'      ? 'selected' : ''}>💬 Mensagem</option>
                                <option value="clear"        ${action === 'clear'        ? 'selected' : ''}>🗑 Limpar</option>
                                <option value="clear_msg"    ${action === 'clear_msg'    ? 'selected' : ''}>🗑 Limp+Msg</option>
                                <option value="terminate"    ${action === 'terminate'    ? 'selected' : ''}>🚪 Encerrar</option>
                            </select>
                            ${action === 'navigate' ? `
                                <select class="nav-sel" onchange="updateNavigationRule(${rule.id}, 'toScreen', this.value)">
                                    ${!toScreen ? `<option value="">⚠️ ${rule.originalToScreenName || 'Tela'}</option>` : ''}
                                    ${app.screens.map(s => `<option value="${s.id}" ${s.id === rule.toScreen ? 'selected' : ''}>${s.name}</option>`).join('')}
                                </select>
                            ` : action === 'navigate_msg' ? `
                                <select class="nav-sel" style="max-width:80px" onchange="updateNavigationRule(${rule.id}, 'toScreen', this.value)">
                                    ${!toScreen ? `<option value="">⚠️ ${rule.originalToScreenName || 'Tela'}</option>` : ''}
                                    ${app.screens.map(s => `<option value="${s.id}" ${s.id === rule.toScreen ? 'selected' : ''}>${s.name}</option>`).join('')}
                                </select>
                                <input type="text" class="nav-msg-input" id="msg_${rule.id}"
                                    value="${(rule.message || '').replace(/"/g, '&quot;')}"
                                    placeholder="Mensagem…" maxlength="80"
                                    oninput="updateNavigationRule(${rule.id}, 'message', this.value)"
                                    onkeydown="event.stopPropagation()">
                            ` : action === 'clear' ? `
                                <span class="nav-clear-info">Limpa todos os campos</span>
                            ` : action === 'terminate' ? `
                                <span class="nav-clear-info">🚪 Encerra a sessão — tela em branco</span>
                            ` : `
                                <input type="text" class="nav-msg-input" id="msg_${rule.id}"
                                    value="${(rule.message || '').replace(/"/g, '&quot;')}"
                                    placeholder="${action === 'clear_msg' ? 'Msg após limpar…' : 'Mensagem…'}" maxlength="80"
                                    oninput="updateNavigationRule(${rule.id}, 'message', this.value)"
                                    onkeydown="event.stopPropagation()">
                            `}
                            <button class="nav-del-btn" onclick="deleteNavigationRule(${rule.id})" title="Remover regra">🗑</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function updateNavigationRule(ruleId, field, value) {
            const rule = app.navigationRules.find(r => r.id === ruleId);
            if (!rule) return;
            
            // Verificar duplicatas ao mudar tela DE, tecla, ação ou tela PARA
            if (field === 'fromScreen' || field === 'key' || field === 'action' || field === 'toScreen') {
                const newFromScreen = field === 'fromScreen' ? parseFloat(value) : rule.fromScreen;
                const newKey = field === 'key' ? value : rule.key;
                const newAction = field === 'action' ? value : rule.action;
                const newToScreen = field === 'toScreen' ? parseFloat(value) : rule.toScreen;
                
                // Buscar regras com mesma combinação: fromScreen + key + action + toScreen
                const duplicates = app.navigationRules.filter(r => 
                    r.id !== ruleId && 
                    r.fromScreen === newFromScreen && 
                    r.key === newKey &&
                    r.action === newAction &&
                    (newAction === 'message' || r.toScreen === newToScreen) // Para message, toScreen não importa
                );
                
                if (duplicates.length > 0) {
                    showMessage('Já existe uma regra com essa combinação exata!', 'error');
                    renderNavigationRules();
                    return;
                }
            }
            
            if (field === 'fromScreen' || field === 'toScreen') {
                rule[field] = parseFloat(value);
            } else {
                rule[field] = value;
            }
            
            // Se estava precisando de associação e agora tem as telas necessárias, remover flag
            if (rule.needsMapping) {
                const hasFrom = rule.fromScreen && rule.fromScreen !== 0;
                const hasTo = rule.toScreen && rule.toScreen !== 0;
                const needsTo = rule.action === 'navigate' || rule.action === 'navigate_msg'; // Precisa de toScreen se for navigate ou navigate_msg
                
                if (hasFrom && (!needsTo || hasTo)) {
                    delete rule.needsMapping;
                    delete rule.originalFromScreenName;
                    delete rule.originalToScreenName;
                }
            }
            
            // Não re-renderizar se for apenas mudança de mensagem (para não perder o foco)
            if (field !== 'message') {
                renderNavigationRules();
            }
            markDirty();
            updatePFKeysLabels();
            if ((app.activeCodeTab || 'cics') === 'cics') updateCodePanel(true);
        }

        function deleteNavigationRule(ruleId) {
            const index = app.navigationRules.findIndex(r => r.id === ruleId);
            if (index !== -1) {
                app.navigationRules.splice(index, 1);
                markDirty();
                renderNavigationRules();
                updatePFKeysLabels();
                if ((app.activeCodeTab || 'cics') === 'cics') updateCodePanel(true);
            }
        }

        function updatePFKeysLabels() {
            const currentScreen = app.screens[app.currentScreenIndex];
            
            console.log('[updatePFKeysLabels] Tela atual:', currentScreen ? currentScreen.name : 'nenhuma');
            console.log('[updatePFKeysLabels] PF Keys na tela:', currentScreen ? currentScreen.pfKeys : 'nenhuma');
            
            if (!currentScreen) {
                resetPFKeysLabels();
                return;
            }

            // Resetar todos os labels primeiro (padrão)
            resetPFKeysLabels();

            const pfKeys = ['ENTER', 'PF1', 'PF2', 'PF3', 'PF4', 'PF5', 'PF6', 'PF7', 'PF8', 'PF9', 'PF10', 'PF11', 'PF12'];
            
            pfKeys.forEach(key => {
                const keyElement = document.querySelector(`[data-key="${key}"]`);
                if (!keyElement) return;
                
                let label = '';
                let fromTxt = false;
                let fromRule = false;
                
                // 1ª Prioridade: PFs do TXT
                if (currentScreen.pfKeys && currentScreen.pfKeys[key]) {
                    label = currentScreen.pfKeys[key];
                    fromTxt = true;
                    console.log(`[updatePFKeysLabels] ${key}: encontrado no TXT = "${label}"`);
                }
                
                // 2ª Prioridade: Regras customizadas (sobrescreve TXT)
                const rule = app.navigationRules.find(r => 
                    r.fromScreen === currentScreen.id && r.key === key
                );
                
                if (rule) {
                    console.log(`[updatePFKeysLabels] ${key}: regra encontrada`, rule);
                    const action = rule.action || 'navigate';
                    
                    if (action === 'navigate') {
                        const targetScreen = app.screens.find(s => s.id === rule.toScreen);
                        if (targetScreen) {
                            label = targetScreen.name.replace(/\.(txt|TXT)$/, '').substring(0, 12);
                            fromRule = true;
                            fromTxt = false;
                            console.log(`[updatePFKeysLabels] ${key}: com destino = "${label}"`);
                        } else if (rule.label) {
                            // Se não há tela de destino mas há label da regra (do TXT), usar ele
                            label = rule.label.substring(0, 12);
                            fromTxt = true; // Manter como TXT pois vem do arquivo original
                            console.log(`[updatePFKeysLabels] ${key}: sem destino, usando label da regra = "${label}"`);
                        }
                    } else if (action === 'message') {
                        label = (rule.message || 'MSG').substring(0, 12);
                        fromRule = true;
                        fromTxt = false;
                        console.log(`[updatePFKeysLabels] ${key}: ação message = "${label}"`);
                    }
                }
                
                // Aplicar label se houver
                if (label) {
                    console.log(`[updatePFKeysLabels] ${key}: APLICANDO label = "${label}"`);
                    keyElement.innerHTML = `${key}<br><span style="font-size: 9px;">${label}</span>`;
                    keyElement.classList.add('nav-key');
                    if (fromRule) {
                        keyElement.style.borderColor = '#00ff00'; // Verde para regras customizadas completas
                    } else if (fromTxt) {
                        keyElement.style.borderColor = '#0088ff'; // Azul para PFs do TXT
                    }
                }
            });
        }

        function resetPFKeysLabels() {
            const defaultLabels = {
                'ENTER': 'SUBMIT',
                'PF1': 'HELP',
                'PF2': 'SPLIT',
                'PF3': 'EXIT',
                'PF4': 'RETURN',
                'PF5': 'RFIND',
                'PF6': 'RCHANGE',
                'PF7': '⬆ PREV',
                'PF8': '⬇ NEXT',
                'PF9': 'SWAP',
                'PF10': 'LEFT',
                'PF11': 'RIGHT',
                'PF12': 'CANCEL'
            };

            Object.keys(defaultLabels).forEach(key => {
                const keyElement = document.querySelector(`[data-key="${key}"]`);
                if (keyElement) {
                    keyElement.innerHTML = `${key}<br>${defaultLabels[key]}`;
                    if (key !== 'PF7' && key !== 'PF8') {
                        keyElement.classList.remove('nav-key');
                    }
                }
            });
        }

        // Manipulação de Campos
        function focusField(index) {
            if (index < 0 || index >= app.fields.length) return;
            
            // Validar campo anterior antes de sair
            const previousField = app.fields[app.currentFieldIndex];
            if (previousField && app.currentFieldIndex !== index) {
                if (!previousField.isValid()) {
                    displayMessageOnFirstLine(previousField.errorMessage);
                    animateFieldError(previousField);
                    // NÃO permite sair do campo com erro - cursor fica no campo atual
                    return;
                }
            }
            
            app.currentFieldIndex = index;
            const field = app.fields[index];
            app.cursorRow = field.row;
            app.cursorCol = field.col;
            
            updateCursorPosition();
            highlightCurrentField();
            updateFieldInfo(field);

            // Atualizar barra mobile e configurar teclado virtual
            var lbl = document.getElementById('mobileFieldLabel');
            if (lbl) {
                var fname = field.bmsName || field.label || ('Campo ' + (index + 1));
                lbl.textContent = fname + (field.type === 'numeric' ? ' [núm]' : '');
            }
            var mi = document.getElementById('mobileTerminalInput');
            if (mi) {
                mi.inputMode = field.type === 'numeric' ? 'numeric' : 'text';
                mi.setAttribute('autocapitalize', field.type === 'numeric' ? 'off' : 'characters');
            }
        }

        function highlightCurrentField() {
            document.querySelectorAll('.field-highlight').forEach(el => {
                el.classList.remove('field-highlight');
            });
            
            const field = app.fields[app.currentFieldIndex];
            if (field) {
                for (let i = 0; i < field.length; i++) {
                    const cell = document.querySelector(
                        `[data-row="${field.row}"][data-col="${field.col + i}"]`
                    );
                    if (cell) {
                        cell.classList.add('field-highlight');
                    }
                }
            }
        }

        function updateCursorPosition() {
            const cursor = document.getElementById('cursor');
            if (cursor) {
                /* Posicionamento lógico direto — funciona com qualquer escala CSS */
                cursor.style.left = (app.cursorCol * 9)  + 'px';
                cursor.style.top  = (app.cursorRow * 18) + 'px';
            }
            document.getElementById('cursorPos').textContent = 
                `${String(app.cursorRow + 1).padStart(2, '0')}/${String(app.cursorCol + 1).padStart(2, '0')}`;
        }

        function updateFieldInfo(field) {
            const info = field.type === 'numeric' ? 'NUMERIC FIELD' : 'ALPHANUMERIC FIELD';
            document.getElementById('fieldInfo').textContent = info;
        }

        function updateScreenInfo() {
            document.getElementById('currentScreenName').textContent = 
                app.currentScreenIndex >= 0 ? app.screens[app.currentScreenIndex].name : 'NENHUMA TELA';
            document.getElementById('currentScreenIndex').textContent = 
                app.currentScreenIndex >= 0 ? app.currentScreenIndex + 1 : 0;
            document.getElementById('totalScreens').textContent = app.screens.length;
        }

        // ═══════════════════════════════════════════════════════
        //  EDITOR DE LAYOUT DA TELA
        // ═══════════════════════════════════════════════════════

        function buildScreenRawText(screen) {
            // Retorna EXATAMENTE 24 linhas × 80 colunas — nunca mais, nunca menos
            // PF keys são preservadas separadamente em app._editPFLines
            const lines = [];
            for (let row = 0; row < ROWS; row++) {
                let line = '';
                const rowData = (screen.data && screen.data[row]) ? screen.data[row] : null;
                for (let col = 0; col < COLS; col++) {
                    const field = screen.fields && screen.fields.find(f =>
                        f.row === row && col >= f.col && col < f.col + f.length
                    );
                    if (field && field.row !== 0) {
                        line += field.type === 'numeric' ? 'x' : 'z';
                    } else if (rowData) {
                        const ch = rowData[col];
                        // Aceitar apenas caracteres únicos e imprimíveis
                        line += (typeof ch === 'string' && ch.length === 1 && ch !== '\n' && ch !== '\r') ? ch : ' ';
                    } else {
                        line += ' ';
                    }
                }
                // Garantir exatamente 80 colunas por linha
                lines.push(line.slice(0, COLS).padEnd(COLS, ' '));
            }
            // Garantir exatamente ROWS linhas
            while (lines.length < ROWS) lines.push(' '.repeat(COLS));
            return lines.slice(0, ROWS).join('\n');
        }

        function _editorUpdateStatus(ta) {
            const status = document.getElementById('screenEditorStatus');
            if (!status) return;
            const before = ta.value.substring(0, ta.selectionStart);
            const linesArr = before.split('\n');
            const ln  = linesArr.length;
            const col = linesArr[linesArr.length - 1].length + 1;
            const overflow = ln > 24 || col > 80;
            if (ln === 1) {
                status.textContent = `LN: ${ln}   COL: ${col}  ⛔ Linha 1: destinada a mensagem do sistema`;
                status.classList.add('overflow');
            } else {
                status.textContent = `LN: ${ln}   COL: ${col}`;
                status.classList.toggle('overflow', overflow);
            }
        }

        // Mapa de substituição: acentos/ç → equivalente ASCII
        const _accentMap = {
            'á':'a','à':'a','â':'a','ã':'a','ä':'a','å':'a',
            'Á':'A','À':'A','Â':'A','Ã':'A','Ä':'A','Å':'A',
            'é':'e','è':'e','ê':'e','ë':'e',
            'É':'E','È':'E','Ê':'E','Ë':'E',
            'í':'i','ì':'i','î':'i','ï':'i',
            'Í':'I','Ì':'I','Î':'I','Ï':'I',
            'ó':'o','ò':'o','ô':'o','õ':'o','ö':'o',
            'Ó':'O','Ò':'O','Ô':'O','Õ':'O','Ö':'O',
            'ú':'u','ù':'u','û':'u','ü':'u',
            'Ú':'U','Ù':'U','Û':'U','Ü':'U',
            'ç':'c','Ç':'C','ñ':'n','Ñ':'N',
            // Box-drawing: substituir por equivalentes ASCII seguros
            '═':'-','─':'-','━':'-','╌':'-','╍':'-','┄':'-','┅':'-','┈':'-','┉':'-',
            '║':'|','│':'|','┃':'|','╎':'|','╏':'|','┆':'|','┇':'|','┊':'|','┋':'|',
            '╔':'+','╗':'+','╚':'+','╝':'+','╠':'+','╣':'+','╦':'+','╩':'+','╬':'+',
            '┌':'+','┐':'+','└':'+','┘':'+','├':'+','┤':'+','┬':'+','┴':'+','┼':'+'
        };
        function _stripAccents(str) {
            return str.replace(/[^\x00-\x7F]/g, ch => _accentMap[ch] !== undefined ? _accentMap[ch] : ch);
        }

        function _editorEnforce(ta) {
            const sel = ta.selectionStart;
            let lines = ta.value.split('\n');
            let changed = false;
            // Linha 1 (índice 0) é reservada para mensagem do sistema — manter sempre em branco
            if (lines[0] && lines[0].trim() !== '') {
                lines[0] = ' '.repeat(lines[0].length);
                changed = true;
                showMessage('Linha 1: destinada a mensagem do sistema — nao e editavel.', 'error');
            }
            // Remover acentos e ç de todas as linhas
            for (let i = 0; i < lines.length; i++) {
                const stripped = _stripAccents(lines[i]);
                if (stripped !== lines[i]) {
                    lines[i] = stripped;
                    changed = true;
                    if (i > 0) showMessage('Caracteres especiais (acentos, C-cedilha, box-drawing) nao sao permitidos — convertidos para ASCII.', 'error');
                }
            }
            // Truncar cada linha a 80 colunas
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].length > 80) {
                    lines[i] = lines[i].slice(0, 80);
                    changed = true;
                }
            }
            // Truncar a 24 linhas
            if (lines.length > 24) {
                lines = lines.slice(0, 24);
                changed = true;
            }
            if (changed) {
                ta.value = lines.join('\n');
                ta.selectionStart = ta.selectionEnd = Math.min(sel, ta.value.length);
            }
        }

        function toggleScreenEditor() {
            if (app.editMode) {
                closeScreenEditor(true);
            } else {
                openScreenEditor();
            }
        }

        function openScreenEditor() {
            if (app.currentScreenIndex < 0) {
                showMessage('Carregue uma tela primeiro!', 'error');
                return;
            }
            const screen = app.screens[app.currentScreenIndex];

            // Preservar linhas de PF keys separadamente
            const pfKeys = screen.pfKeys || {};
            app._editPFLines = Object.keys(pfKeys).length > 0
                ? Object.entries(pfKeys).map(([key, label]) => `${key}=${label}`).join('  ')
                : '';

            const ta = document.getElementById('screenEditorTextArea');
            ta.value = buildScreenRawText(screen);
            // Aplicar enforcement IMEDIATAMENTE ao carregar (não apenas no evento input)
            _editorEnforce(ta);

            document.getElementById('screenEditorOverlay').style.display = 'flex';

            // Atualizar botão
            document.getElementById('btnEditScreenIcon').textContent = '✅';
            document.getElementById('btnEditScreenLabel').textContent = ' Fechar Edição';
            document.getElementById('btnEditScreen').classList.add('active');

            document.getElementById('terminalWrap').classList.add('edit-mode');

            app.editMode = true;

            // Listeners: tracking de posição + enforcement de limites
            ta._editorInput = function() {
                _editorEnforce(ta);
                _editorUpdateStatus(ta);
                // Atualização em tempo real: parsear conteúdo atual e regenerar BMS/COBOL
                if (app.currentScreenIndex >= 0) {
                    const screen = app.screens[app.currentScreenIndex];
                    let previewLines = ta.value.split('\n').slice(0, 24).map(l => l.slice(0, 80));
                    let previewContent = previewLines.join('\n');
                    if (app._editPFLines) previewContent += '\n' + app._editPFLines;
                    const prevContent   = screen.content;
                    const prevFields    = screen.fields;
                    const prevData      = screen.data;
                    const prevBmsSrc    = screen.bmsSource;
                    const prevBmsImp    = screen.bmsImported;
                    const prevBmsHdr    = screen._bmsHeader;
                    screen.content = previewContent;
                    // Sem bmsSource: generateBMSCode será usado no preview
                    screen.bmsSource = null;
                    screen.parseContent();
                    // Restaurar flags e bmsVariable dos campos originais para o preview
                    if (prevBmsImp) {
                        screen.bmsImported = true;
                        if (prevBmsHdr) screen._bmsHeader = prevBmsHdr;
                    }
                    if ((prevBmsSrc || prevBmsImp) && prevFields) {
                        const pvMap = {};
                        prevFields.forEach(function(f) {
                            if (f.bmsVariable) pvMap[f.row + ':' + f.col] = f.bmsVariable;
                        });
                        screen.fields.forEach(function(f) {
                            const k = f.row + ':' + f.col;
                            if (pvMap[k]) f.bmsVariable = pvMap[k];
                        });
                    }
                    updateCodePanel();
                    // Restaurar estado real (sem aplicar ao terminal)
                    screen.content      = prevContent;
                    screen.fields       = prevFields;
                    screen.data         = prevData;
                    screen.bmsSource    = prevBmsSrc;
                    screen.bmsImported  = prevBmsImp;
                    screen._bmsHeader   = prevBmsHdr;
                }
            };
            ta._editorCursor = function() { _editorUpdateStatus(ta); };

            ta.addEventListener('input',   ta._editorInput);
            ta.addEventListener('keyup',   ta._editorCursor);
            ta.addEventListener('click',   ta._editorCursor);
            ta.addEventListener('selectionchange', ta._editorCursor);

            _editorUpdateStatus(ta);
            ta.focus();
            showMessage('Modo edição — 24 li × 80 col | feche para aplicar', 'info');
        }

        function closeScreenEditor(apply) {
            const ta = document.getElementById('screenEditorTextArea');

            // Remover listeners
            if (ta._editorInput)  { ta.removeEventListener('input',   ta._editorInput);  delete ta._editorInput; }
            if (ta._editorCursor) {
                ta.removeEventListener('keyup',   ta._editorCursor);
                ta.removeEventListener('click',   ta._editorCursor);
                ta.removeEventListener('selectionchange', ta._editorCursor);
                delete ta._editorCursor;
            }

            document.getElementById('screenEditorOverlay').style.display = 'none';
            document.getElementById('terminalWrap').classList.remove('edit-mode');

            // Restaurar botão
            document.getElementById('btnEditScreenIcon').textContent = '✏️';
            document.getElementById('btnEditScreenLabel').textContent = ' Editar';
            document.getElementById('btnEditScreen').classList.remove('active');

            app.editMode = false;

            if (apply && app.currentScreenIndex >= 0) {
                const screen = app.screens[app.currentScreenIndex];

                // Garantir máx. 24 linhas × 80 cols
                let screenLines = ta.value.split('\n').slice(0, 24);
                screenLines = screenLines.map(l => l.slice(0, 80));

                // Recompor conteúdo: 24 linhas da tela + linha de PF keys preservada
                let newContent = screenLines.join('\n');
                if (app._editPFLines) newContent += '\n' + app._editPFLines;

                screen.content = newContent;

                // Salvar mapeamento posição → bmsVariable dos campos originais
                // para reutilizar os nomes do BMS importado após o re-parse
                const bmsVarByPos = {};
                const wasBmsImported = !!screen.bmsImported;
                const savedBmsHeader = screen._bmsHeader || null;
                if (screen.bmsSource || wasBmsImported) {
                    (screen.fields || []).forEach(function(f) {
                        if (f.bmsVariable) bmsVarByPos[f.row + ':' + f.col] = f.bmsVariable;
                    });
                }

                // Descartar bmsSource: após edição o BMS será regenerado via generateBMSCode,
                // mas com os nomes originais restaurados onde a posição coincide
                screen.bmsSource = null;
                screen.parseContent();

                // Restaurar bmsVariable nos campos que permaneceram na mesma posição
                if (Object.keys(bmsVarByPos).length > 0) {
                    screen.fields.forEach(function(f) {
                        const key = f.row + ':' + f.col;
                        if (bmsVarByPos[key]) f.bmsVariable = bmsVarByPos[key];
                    });
                }

                // Restaurar flags de origem BMS após re-parse
                if (wasBmsImported) {
                    screen.bmsImported = true;
                    if (savedBmsHeader) screen._bmsHeader = savedBmsHeader;
                }

                app.fields = screen.fields;
                app.currentFieldIndex = 0;
                if (app.fields.length > 0) {
                    app.cursorRow = app.fields[0].row;
                    app.cursorCol = app.fields[0].col;
                }

                renderScreen(screen);
                updateCursorPosition();
                highlightCurrentField();
                updateScreenInfo();
                updatePFKeysLabels();
                updateScreenFieldsCount();
                updateCodePanel(true);

                selectedFieldIndex = -1;
                renderFieldsList();
                if (selectedFieldIndex >= 0) renderFieldConfig();

                markDirty();
                const wasImported = !!screen.bmsSource;
                showMessage(
                    wasImported
                        ? 'Layout atualizado! COBOL regenerado (BMS original preservado).'
                        : 'Layout atualizado! BMS e COBOL regenerados.',
                    'success'
                );
            }
        }

        // Manipulação de Teclado
        function handleKeyPress(e) {
            // Ignorar eventos de teclado se o modo de edição da tela estiver ativo
            // Exceção: deixar Ctrl+Z / Ctrl+Y / Ctrl+A / Ctrl+C / Ctrl+V agir
            // normalmente no textarea (undo/redo/select/copy/paste nativos do browser)
            if (app.editMode) {
                if (e.ctrlKey || e.metaKey) return; // passa para o textarea
                return;
            }

            // Ignorar se algum modal com input estiver aberto (ex: Nova Tela)
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Ignorar eventos de teclado se estiver digitando no painel de validação
            const validationPanel = document.getElementById('validationPanel');
            const isTypingInValidation = validationPanel && 
                validationPanel.contains(e.target) && 
                (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA');
            
            if (isTypingInValidation) {
                return; // Deixa o evento ser processado normalmente pelo input
            }
            
            if (app.currentScreenIndex < 0 || app.fields.length === 0) return;
            
            const field = app.fields[app.currentFieldIndex];
            if (!field) return;
            
            // Bloquear edição no campo MENSAGEM (somente leitura)
            const isMessageField = field.label === 'MENSAGEM' || field.row === 0;
            
            // Navegação entre campos
            if (e.key === 'Tab') {
                e.preventDefault();
                if (e.shiftKey) {
                    focusField((app.currentFieldIndex - 1 + app.fields.length) % app.fields.length);
                } else {
                    focusField((app.currentFieldIndex + 1) % app.fields.length);
                }
            }
            // Navegação entre telas
            else if (e.key === 'PageDown' || (e.key === 'F8' && !e.shiftKey)) {
                e.preventDefault();
                if (app.validationKeys.includes('PF8') && !validateAllFields()) return;
                applyNavigationRule('PF8');
            }
            else if (e.key === 'PageUp' || e.key === 'F7') {
                e.preventDefault();
                if (app.validationKeys.includes('PF7') && !validateAllFields()) return;
                applyNavigationRule('PF7');
            }
            // Teclas de função
            else if (e.key === 'F1') {
                e.preventDefault();
                if (app.validationKeys.includes('PF1') && !validateAllFields()) return;
                applyNavigationRule('PF1');
            }
            else if (e.key === 'F2') {
                e.preventDefault();
                if (app.validationKeys.includes('PF2') && !validateAllFields()) return;
                applyNavigationRule('PF2');
            }
            else if (e.key === 'F3') {
                e.preventDefault();
                if (app.validationKeys.includes('PF3') && !validateAllFields()) return;
                applyNavigationRule('PF3');
            }
            else if (e.key === 'F4') {
                e.preventDefault();
                if (app.validationKeys.includes('PF4') && !validateAllFields()) return;
                applyNavigationRule('PF4');
            }
            else if (e.key === 'F5') {
                e.preventDefault();
                if (app.validationKeys.includes('PF5') && !validateAllFields()) return;
                applyNavigationRule('PF5');
            }
            else if (e.key === 'F6') {
                e.preventDefault();
                if (app.validationKeys.includes('PF6') && !validateAllFields()) return;
                applyNavigationRule('PF6');
            }
            else if (e.key === 'F9') {
                e.preventDefault();
                if (app.validationKeys.includes('PF9') && !validateAllFields()) return;
                applyNavigationRule('PF9');
            }
            else if (e.key === 'F10') {
                e.preventDefault();
                if (app.validationKeys.includes('PF10') && !validateAllFields()) return;
                applyNavigationRule('PF10');
            }
            else if (e.key === 'F11') {
                e.preventDefault();
                if (app.validationKeys.includes('PF11') && !validateAllFields()) return;
                applyNavigationRule('PF11');
            }
            else if (e.key === 'F12') {
                e.preventDefault();
                if (app.validationKeys.includes('PF12') && !validateAllFields()) return;
                applyNavigationRule('PF12');
            }
            else if (e.key === 'Escape') {
                e.preventDefault();
                // Bloquear limpeza no campo MENSAGEM
                if (isMessageField) return;
                
                field.clear();
                renderCurrentScreen();
            }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (app.validationKeys.includes('ENTER') && !validateAllFields()) return;
                if (!applyNavigationRule('ENTER')) {
                    submitData();
                }
            }
            // Navegação dentro do campo
            else if (e.key === 'ArrowLeft' && app.cursorCol > field.col) {
                app.cursorCol--;
                updateCursorPosition();
            }
            else if (e.key === 'ArrowRight' && app.cursorCol < field.col + field.length - 1) {
                app.cursorCol++;
                updateCursorPosition();
            }
            // Edição
            else if (e.key === 'Backspace') {
                e.preventDefault();
                // Bloquear edição no campo MENSAGEM
                if (isMessageField) return;
                
                const pos = app.cursorCol - field.col;
                if (pos > 0) {
                    field.value = field.value.slice(0, pos - 1) + field.value.slice(pos);
                    app.cursorCol--;
                    updateCursorPosition();
                    renderCurrentScreen();
                }
            }
            else if (e.key === 'Delete') {
                e.preventDefault();
                // Bloquear edição no campo MENSAGEM
                if (isMessageField) return;
                
                const pos = app.cursorCol - field.col;
                field.value = field.value.slice(0, pos) + field.value.slice(pos + 1);
                renderCurrentScreen();
            }
            // Entrada de texto
            else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                
                // Bloquear edição no campo MENSAGEM
                if (isMessageField) return;
                
                if (field.type === 'numeric' && !/\d/.test(e.key)) {
                    showMessage('Este campo aceita apenas números!', 'error');
                    animateFieldError(field);
                    return;
                }
                
                const pos = app.cursorCol - field.col;
                if (field.value.length < field.length) {
                    field.value = field.value.slice(0, pos) + e.key + field.value.slice(pos);
                    if (app.cursorCol < field.col + field.length - 1) {
                        app.cursorCol++;
                    }
                    updateCursorPosition();
                    renderCurrentScreen();
                }
            }
        }

        function handleFunctionKey(e) {
            const key = e.currentTarget.dataset.key;
            const button = e.currentTarget;
            
            button.classList.add('pressed');
            setTimeout(() => {
                if (button && button.classList) {
                    button.classList.remove('pressed');
                }
            }, 200);
            
            // Validar campos APENAS se a tecla estiver configurada para validar
            if (app.validationKeys.includes(key)) {
                if (!validateAllFields()) {
                    return; // Bloqueia a ação se houver erro de validação
                }
            }
            
            switch(key) {
                case 'PF1':
                    applyNavigationRule('PF1');
                    break;
                case 'PF2':
                    applyNavigationRule('PF2');
                    break;
                case 'PF3':
                    applyNavigationRule('PF3');
                    break;
                case 'PF4':
                    applyNavigationRule('PF4');
                    break;
                case 'PF5':
                    applyNavigationRule('PF5');
                    break;
                case 'PF6':
                    applyNavigationRule('PF6');
                    break;
                case 'PF7':
                    applyNavigationRule('PF7');
                    break;
                case 'PF8':
                    applyNavigationRule('PF8');
                    break;
                case 'PF9':
                    applyNavigationRule('PF9');
                    break;
                case 'PF10':
                    applyNavigationRule('PF10');
                    break;
                case 'PF11':
                    applyNavigationRule('PF11');
                    break;
                case 'PF12':
                    applyNavigationRule('PF12');
                    break;
                case 'ENTER':
                    // Se passou na validação, executar regra ou submit
                    if (!applyNavigationRule('ENTER')) {
                        submitData();
                    }
                    break;
                default:
                    displayMessageOnFirstLine('TECLA INVALIDA');
            }
        }

        function renderCurrentScreen() {
            if (app.currentScreenIndex >= 0) {
                renderScreen(app.screens[app.currentScreenIndex]);
                highlightCurrentField();
            }
        }

        function animateFieldError(field) {
            for (let i = 0; i < field.length; i++) {
                const cell = document.querySelector(
                    `[data-row="${field.row}"][data-col="${field.col + i}"]`
                );
                if (cell) {
                    cell.classList.add('error');
                    setTimeout(() => cell.classList.remove('error'), 1000);
                }
            }
        }

        function clearAllFields() {
            app.fields.forEach(field => field.clear());
            renderCurrentScreen();
            showMessage('Todos os campos foram limpos', 'success');
        }

        function clearScreen() {
            if (confirm('Limpar toda a tela?')) {
                initTerminal();
                showMessage('Tela limpa', 'success');
            }
        }

        function exitScreen() {
            if (confirm('Deseja sair?')) {
                showMessage('Sessão encerrada', 'success');
                setTimeout(() => {
                    initTerminal();
                    app.currentScreenIndex = -1;
                    app.fields = [];
                    updateScreenInfo();
                }, 1500);
            }
        }

        function submitData() {
            // Validar todos os campos antes de submeter
            if (!validateAllFields()) {
                return;
            }
            
            const data = {};
            
            app.fields.forEach((field, index) => {
                data[`field_${index}`] = {
                    type: field.type,
                    value: field.value,
                    row: field.row,
                    col: field.col
                };
            });
            
            showLoader();
            
            setTimeout(() => {
                hideLoader();
                console.log('Dados submetidos:', data);
                showMessage('Dados processados com sucesso!', 'success');
                
                // Navegar para próxima tela se houver regra
                checkNavigationRules();
            }, 1500);
        }

        function checkNavigationRules() {
            // Verificar se há regra de navegação para a tela atual
            const currentScreen = app.screens[app.currentScreenIndex];
            if (!currentScreen) return;

            const rule = app.navigationRules.find(r => r.id === currentScreen.id && r.key === 'ENTER');
            
            if (rule) {
                // Encontrar índice da tela de destino
                const targetIndex = app.screens.findIndex(s => s.id === rule.toScreen);
                if (targetIndex !== -1) {
                    setTimeout(() => {
                        loadScreen(targetIndex);
                    }, 500);
                    return;
                }
            }

            // Se não há regra específica e há mais telas, vai para próxima
            if (app.screens.length > 1) {
                setTimeout(() => {
                    nextScreen();
                }, 500);
            }
        }

        function applyNavigationRule(key) {
            const currentScreen = app.screens[app.currentScreenIndex];
            if (!currentScreen) return false;

            // Limpar mensagem anterior ao executar qualquer PF
            clearMessageLine();

            // Buscar todas as regras para esta tecla na tela atual
            const rules = app.navigationRules.filter(r => 
                r.fromScreen === currentScreen.id && r.key === key
            );
            
            // Verificar se a tecla está definida no TXT da tela
            const pfKeyFromTXT = currentScreen.pfKeys && currentScreen.pfKeys[key];
            
            // Se não tem regra customizada e não tem no TXT, mostrar TECLA INVALIDA
            if (rules.length === 0 && !pfKeyFromTXT) {
                displayMessageOnFirstLine('TECLA INVALIDA');
                return true; // Consumir a tecla para não executar comportamento padrão
            }
            
            // Se não tem regra customizada mas tem no TXT, executar ação do TXT
            if (rules.length === 0 && pfKeyFromTXT) {
                executePFKeyAction(key, pfKeyFromTXT);
                return true;
            }
            
            // Verificar se alguma regra precisa de associação
            const unmappedRules = rules.filter(r => r.needsMapping);
            if (unmappedRules.length > 0) {
                displayMessageOnFirstLine('REGRA PRECISA DE ASSOCIACAO - ABRA PAINEL DE NAVEGACAO');
                return true; // Consumir a tecla para não executar comportamento padrão
            }
            
            // Separar regras por tipo
            const navRule = rules.find(r => r.action === 'navigate');
            const navMsgRule = rules.find(r => r.action === 'navigate_msg');
            const msgRule = rules.find(r => r.action === 'message');
            const clearRule = rules.find(r => r.action === 'clear');
            const clearMsgRule = rules.find(r => r.action === 'clear_msg');
            const terminateRule = rules.find(r => r.action === 'terminate');

            // Encerrar sessão: limpa tudo e mostra tela em branco
            if (terminateRule) {
                app.fields.forEach(f => { f.value = Array(f.length).fill(' '); });
                initTerminal();
                app.currentScreenIndex = -1;
                app.fields = [];
                updateScreenInfo();
                _highlightPanelField(-1);
                return true;
            }

            let navigated = false;
            
            // 1º: Executar limpeza se houver
            if (clearRule) {
                clearAllFields();
                displayMessageOnFirstLine('CAMPOS LIMPOS');
            }
            
            // 1º: Executar limpeza com mensagem se houver
            if (clearMsgRule) {
                clearAllFields();
                const message = clearMsgRule.message || 'CAMPOS LIMPOS';
                displayMessageOnFirstLine(message);
            }
            
            // 2º: Executar navegação se houver (navigate ou navigate_msg)
            const ruleToNavigate = navMsgRule || navRule;
            if (ruleToNavigate) {
                const targetIndex = app.screens.findIndex(s => s.id === ruleToNavigate.toScreen);
                if (targetIndex !== -1) {
                    loadScreen(targetIndex);
                    navigated = true;
                    
                    // Se for navigate_msg, mostrar mensagem na tela carregada
                    if (navMsgRule && navMsgRule.message) {
                        setTimeout(() => {
                            displayMessageOnFirstLine(navMsgRule.message);
                        }, 100);
                    }
                }
            }
            
            // 2º: Executar mensagem pura se houver (message sem navegação)
            if (msgRule) {
                const message = msgRule.message || 'Tecla configurada';
                // Pequeno delay para garantir que a tela foi carregada
                setTimeout(() => {
                    displayMessageOnFirstLine(message);
                }, navigated ? 100 : 0);
            }
            
            return true;
        }

        function executePFKeyAction(key, pfKeyLabel) {
            // Executar ação baseada no label do PF key do TXT
            const label = pfKeyLabel.toUpperCase().trim();
            
            // Ações comuns do mainframe
            if (label.includes('EXIT') || label.includes('SAIR')) {
                exitScreen();
            } else if (label.includes('CLEAR') || label.includes('LIMPAR')) {
                clearAllFields();
            } else if (label.includes('HELP') || label.includes('AJUDA')) {
                displayMessageOnFirstLine('FUNCAO DE AJUDA NAO IMPLEMENTADA');
            } else if (label.includes('PRINT') || label.includes('IMPRIMIR')) {
                displayMessageOnFirstLine('FUNCAO DE IMPRESSAO NAO IMPLEMENTADA');
            } else if (label.includes('REFRESH') || label.includes('ATUALIZAR')) {
                renderCurrentScreen();
                displayMessageOnFirstLine('TELA ATUALIZADA');
            } else if (label.includes('BACK') || label.includes('VOLTAR') || label.includes('PREV')) {
                prevScreen();
            } else if (label.includes('NEXT') || label.includes('PROX')) {
                nextScreen();
            } else {
                // Mostrar o label como mensagem
                displayMessageOnFirstLine(pfKeyLabel);
            }
        }

        function displayMessageOnFirstLine(message) {
            const terminal = document.getElementById('terminal');
            const firstLine = terminal.querySelector('.screen-line');
            if (!firstLine) return;
            
            const chars = firstLine.querySelectorAll('.screen-char');
            const msgText = message.substring(0, 80).padEnd(80, ' ');
            
            chars.forEach((char, index) => {
                char.textContent = msgText[index];
                char.classList.add('message-line');
            });
        }

        function clearMessageLine() {
            const terminal = document.getElementById('terminal');
            const firstLine = terminal.querySelector('.screen-line');
            if (!firstLine) return;
            
            const currentScreen = app.screens[app.currentScreenIndex];
            if (!currentScreen) return;
            
            const chars = firstLine.querySelectorAll('.screen-char');
            chars.forEach((char, index) => {
                char.textContent = currentScreen.data[0][index];
                char.classList.add('message-line');
            });
        }

        // Validação de Campos
        function configureFieldValidation(fieldIndex, validationType, params, message) {
            if (fieldIndex < 0 || fieldIndex >= app.fields.length) return;
            
            const field = app.fields[fieldIndex];
            field.addValidation(validationType, params, message);
            
            showMessage('Validação configurada para o campo!', 'success');
        }

        function validateAllFields() {
            let firstErrorField = null;
            let firstErrorIndex = -1;
            
            // Encontrar o primeiro campo com erro
            for (let i = 0; i < app.fields.length; i++) {
                const field = app.fields[i];
                if (!field.isValid()) {
                    firstErrorField = field;
                    firstErrorIndex = i;
                    break;
                }
            }
            
            if (firstErrorField) {
                // Mostrar apenas a mensagem de erro na primeira linha
                displayMessageOnFirstLine(firstErrorField.errorMessage);
                
                // Mover cursor para o campo com erro
                app.currentFieldIndex = firstErrorIndex;
                app.cursorRow = firstErrorField.row;
                app.cursorCol = firstErrorField.col;
                
                // Atualizar visual
                updateCursorPosition();
                highlightCurrentField();
                updateFieldInfo(firstErrorField);
                animateFieldError(firstErrorField);
                
                return false;
            }
            
            return true;
        }

        function validateCurrentField() {
            const field = app.fields[app.currentFieldIndex];
            if (!field) return true;
            
            if (!field.isValid()) {
                displayMessageOnFirstLine(field.errorMessage);
                animateFieldError(field);
                return false;
            }
            
            return true;
        }

        // Utilitários
        function showMessage(text, type = 'info') {
            const msg = document.getElementById('statusMessage');
            msg.textContent = text;
            msg.className = 'status-message show ' + type;
            
            setTimeout(() => {
                msg.classList.remove('show');
            }, 3000);
        }

        function showLoader() {
            document.getElementById('loader').classList.add('show');
        }

        function hideLoader() {
            document.getElementById('loader').classList.remove('show');
        }

        function updateTime() {
            const now = new Date();
            const time = now.toLocaleTimeString('pt-BR');
            document.getElementById('time').textContent = time;
        }

        // Painel de Validação de Campos
        let selectedFieldIndex = -1;

        function toggleValidationPanel() {
            const panel = document.getElementById('validationPanel');
            const btn = document.getElementById('toggleValidationBtn');
            
            if (panel.classList.contains('collapsed')) {
                panel.classList.remove('collapsed');
                btn.textContent = 'Recolher';
                renderFieldsList();
            } else {
                panel.classList.add('collapsed');
                btn.textContent = 'Expandir';
            }
        }

        function updateValidationKeys() {
            const checkboxes = document.querySelectorAll('.validation-global-config input[type="checkbox"]');
            app.validationKeys = [];
            
            checkboxes.forEach(cb => {
                if (cb.checked) {
                    app.validationKeys.push(cb.value);
                }
            });
            
            const keys = app.validationKeys.length > 0 ? app.validationKeys.join(', ') : 'Nenhuma';
            console.log('Teclas de validação configuradas:', keys);
            updateCodePanel(true);
        }

        function renderFieldsList() {
            const container = document.getElementById('fieldsListContainer');
            
            if (app.currentScreenIndex < 0 || app.fields.length === 0) {
                container.innerHTML = '<div style="text-align: center; opacity: 0.5; padding: 20px;">Nenhuma tela carregada</div>';
                return;
            }

            container.innerHTML = app.fields.map((field, index) => {
                const displayLabel = field.label || `Campo ${index + 1}`;
                const bmsVar = field.bmsVariable ? `BMS: ${field.bmsVariable}` : 'Sem variável BMS';
                return `
                <div class="field-item-val ${selectedFieldIndex === index ? 'selected' : ''}" 
                     onclick="selectFieldForValidation(${index})">
                    <div class="field-label" style="display: flex; align-items: center; gap: 5px;">
                        <span>${displayLabel}</span>
                        <button class="btn-edit-label" onclick="event.stopPropagation(); editFieldLabel(${index})" 
                                title="Editar nome do campo">✏️</button>
                    </div>
                    <div class="field-details">
                        Tipo: ${field.type === 'numeric' ? 'Numérico' : 'Alfanumérico'} | 
                        Tamanho: ${field.length} | 
                        Posição: (${field.row}, ${field.col})
                    </div>
                    <div class="field-details" style="margin-top: 3px; color: ${field.bmsVariable ? 'var(--primary-color)' : 'var(--text-light)'}; font-weight: ${field.bmsVariable ? '600' : '400'};">
                        ${bmsVar}
                    </div>
                    <div class="field-details" style="margin-top: 3px; color: ${field.validationRules.length > 0 ? 'var(--primary-color)' : 'var(--text-light)'}; font-weight: ${field.validationRules.length > 0 ? '600' : '400'};">
                        ${field.validationRules.length} validação(ões) ${field.isRequired ? '| Obrigatório' : ''}
                    </div>
                </div>
            `}).join('');
        }

        function selectFieldForValidation(index) {
            selectedFieldIndex = index;
            renderFieldsList();
            renderFieldConfig();
            _highlightPanelField(index);
        }

        function _highlightPanelField(index) {
            // Remove highlight anterior
            document.querySelectorAll('.field-panel-highlight').forEach(function(el) {
                el.classList.remove('field-panel-highlight');
            });
            if (index < 0 || index >= app.fields.length) return;
            var field = app.fields[index];
            if (!field) return;
            var terminal = document.getElementById('terminal');
            for (var i = 0; i < field.length; i++) {
                var cell = terminal.querySelector(
                    '[data-row="' + field.row + '"][data-col="' + (field.col + i) + '"]'
                );
                if (cell) cell.classList.add('field-panel-highlight');
            }
            // Scroll suave para o campo na tela
            var first = terminal.querySelector('[data-row="' + field.row + '"][data-col="' + field.col + '"]');
            if (first) first.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        function renderFieldConfig() {
            const container = document.getElementById('fieldConfigContent');
            
            if (selectedFieldIndex < 0 || selectedFieldIndex >= app.fields.length) {
                container.innerHTML = '<div style="text-align: center; opacity: 0.5; padding: 20px;">Selecione um campo à esquerda</div>';
                return;
            }

            const field = app.fields[selectedFieldIndex];
            const displayLabel = field.label || `Campo ${selectedFieldIndex + 1}`;

            // Criar lista de opções de campos disponíveis
            const fieldOptions = app.fields.map((f, idx) => {
                const label = f.label || `Campo ${idx + 1}`;
                const bmsVar = f.bmsVariable || '';
                return `<option value="${idx}" ${idx === selectedFieldIndex ? 'selected' : ''}>${label} ${bmsVar ? '(' + bmsVar + ')' : ''}</option>`;
            }).join('');

            // Criar lista para copiar de outro campo
            const copyOptions = '<option value="">-- Copiar de outro campo --</option>' + 
                app.fields.map((f, idx) => {
                    if (idx === selectedFieldIndex) return ''; // Não mostrar o campo atual
                    const label = f.label || `Campo ${idx + 1}`;
                    const bmsVar = f.bmsVariable || '';
                    return `<option value="${idx}">${label} ${bmsVar ? '→ ' + bmsVar : ''}</option>`;
                }).join('');

            container.innerHTML = `
                <div class="field-info-header">
                    <h4 class="field-title">${displayLabel}</h4>
                    <div class="field-metadata">
                        <span class="field-meta-item">📍 Linha ${field.row + 1}, Coluna ${field.col + 1}</span>
                        <span class="field-meta-item">📏 Tamanho: ${field.length}</span>
                        <span class="field-meta-item">🔤 ${field.type === 'numeric' ? 'Numérico' : 'Alfanumérico'}</span>
                    </div>
                </div>

                <div class="form-group">
                    <label>📋 Selecionar Campo da Tela</label>
                    <select id="fieldSelector" onchange="selectFieldForValidation(parseInt(this.value))" 
                            class="modern-select">
                        ${fieldOptions}
                    </select>
                </div>

                <div class="form-group">
                    <label>🏷️ Nome da Variável BMS</label>
                    <input type="text" id="bmsVariableName" value="${field.bmsVariable || ''}" 
                           placeholder="Ex: NOMEI, CPFI, TELEFONE" 
                           onchange="updateBMSVariable()" 
                           class="modern-input" 
                           style="text-transform: uppercase;" 
                           maxlength="30">
                    <div class="field-hint">
                        Edite como preferir - o valor inicial é apenas uma sugestão
                    </div>
                </div>

                <div class="form-group">
                    <label>🔄 Copiar dados de outro campo</label>
                    <select id="copyFromField" onchange="copyFieldData(parseInt(this.value))" 
                            class="modern-select">
                        ${copyOptions}
                    </select>
                    <div class="field-hint">
                        Copiar label e variável BMS de outro campo
                    </div>
                </div>

                <div class="form-group">
                    <label>
                        <input type="checkbox" id="fieldRequired" ${field.isRequired ? 'checked' : ''}
                               onchange="toggleFieldRequired()">
                        Campo Obrigatório
                    </label>
                </div>

                <div class="bms-attributes-section">
                    <div class="bms-attr-header">🎨 Atributos BMS</div>

                    <div class="bms-attr-group">
                        <div class="bms-attr-title">Proteção (escolha 1)</div>
                        <label class="bms-attr-opt">
                            <input type="checkbox" class="bmsProtection" value="UNPROT"
                                   ${field.bmsAttributes.protection === 'UNPROT' ? 'checked' : ''}
                                   onchange="updateBMSAttributes(this)">
                            <span class="bms-attr-key">UNPROT</span>
                            <span class="bms-attr-desc">Campo editável</span>
                        </label>
                        <label class="bms-attr-opt">
                            <input type="checkbox" class="bmsProtection" value="PROT"
                                   ${field.bmsAttributes.protection === 'PROT' ? 'checked' : ''}
                                   onchange="updateBMSAttributes(this)">
                            <span class="bms-attr-key">PROT</span>
                            <span class="bms-attr-desc">Protegido (c/ foco)</span>
                        </label>
                        <label class="bms-attr-opt">
                            <input type="checkbox" class="bmsOther" value="ASKIP"
                                   ${field.bmsAttributes.protection === 'ASKIP' ? 'checked' : ''}
                                   onchange="updateBMSAttributes(this)">
                            <span class="bms-attr-key">ASKIP</span>
                            <span class="bms-attr-desc">Auto-skip (label)</span>
                        </label>
                    </div>

                    <div class="bms-attr-group">
                        <div class="bms-attr-title">Tipo de variável (escolha 1)</div>
                        <label class="bms-attr-opt">
                            <input type="checkbox" class="bmsType" value="NUM"
                                   ${field.bmsAttributes.type === 'NUM' ? 'checked' : ''}
                                   onchange="updateBMSAttributes(this)">
                            <span class="bms-attr-key">NUM</span>
                            <span class="bms-attr-desc">Numérico editável</span>
                        </label>
                        <label class="bms-attr-opt">
                            <input type="checkbox" class="bmsType" value="NORM"
                                   ${field.bmsAttributes.type === 'NORM' ? 'checked' : ''}
                                   onchange="updateBMSAttributes(this)">
                            <span class="bms-attr-key">NORM</span>
                            <span class="bms-attr-desc">Alfanumérico normal</span>
                        </label>
                    </div>

                    <div class="bms-attr-group">
                        <div class="bms-attr-title">Intensidade (escolha 1)</div>
                        <label class="bms-attr-opt">
                            <input type="checkbox" class="bmsIntensity" value="BRT"
                                   ${field.bmsAttributes.intensity === 'BRT' ? 'checked' : ''}
                                   onchange="updateBMSAttributes(this)">
                            <span class="bms-attr-key">BRT</span>
                            <span class="bms-attr-desc">Brilhante</span>
                        </label>
                        <label class="bms-attr-opt">
                            <input type="checkbox" class="bmsIntensity" value="DRK"
                                   ${field.bmsAttributes.intensity === 'DRK' ? 'checked' : ''}
                                   onchange="updateBMSAttributes(this)">
                            <span class="bms-attr-key">DRK</span>
                            <span class="bms-attr-desc">Oculto (senha)</span>
                        </label>
                    </div>

                    <div class="bms-attr-group">
                        <div class="bms-attr-title">Extras (múltipla escolha)</div>
                        <label class="bms-attr-opt">
                            <input type="checkbox" id="bmsIC"
                                   ${field.bmsAttributes.ic ? 'checked' : ''}
                                   onchange="updateBMSAttributes()">
                            <span class="bms-attr-key">IC</span>
                            <span class="bms-attr-desc">Insert Cursor</span>
                        </label>
                        <label class="bms-attr-opt">
                            <input type="checkbox" id="bmsFSET"
                                   ${field.bmsAttributes.fset ? 'checked' : ''}
                                   onchange="updateBMSAttributes()">
                            <span class="bms-attr-key">FSET</span>
                            <span class="bms-attr-desc">Field Set</span>
                        </label>
                    </div>

                    <div class="bms-attr-preview">
                        <div class="bms-attr-preview-lbl">Preview ATTRB</div>
                        <code id="bmsAttrPreview">${getBMSAttrString(field)}</code>
                    </div>
                </div>

                <div class="form-group">
                    <label>Tipo de Validação</label>
                    <select id="validationType">
                        <option value="">Selecione...</option>
                        <option value="minLength">Tamanho Mínimo</option>
                        <option value="maxLength">Tamanho Máximo</option>
                        <option value="exactLength">Tamanho Exato</option>
                        <option value="numeric">Numérico (Apenas Números)</option>
                        <option value="alpha">Alfabético (Apenas Letras)</option>
                        <option value="alphanumeric">Alfanumérico (Letras e Números)</option>
                        <option value="notZeros">Não pode ser apenas Zeros</option>
                        <option value="notSpaces">Não pode ser apenas Espaços</option>
                        <option value="email">Email</option>
                        <option value="cpf">CPF</option>
                        <option value="cnpj">CNPJ</option>
                        <option value="phone">Telefone</option>
                        <option value="date">Data (DD/MM/AAAA)</option>
                        <option value="pattern">Expressão Regular</option>
                    </select>
                </div>

                <div class="form-group" id="paramGroup" style="display: none;">
                    <label id="paramLabel">Parâmetro</label>
                    <input type="text" id="validationParam" placeholder="Digite o parâmetro">
                </div>

                <div class="form-group">
                    <label>Mensagem de Erro</label>
                    <input type="text" id="validationMessage" placeholder="Ex: Campo inválido" maxlength="80">
                </div>

                <div class="btn-group">
                    <button class="btn" onclick="addFieldValidation()">Adicionar Validação</button>
                    <button class="btn danger" onclick="clearFieldValidations()">Limpar Todas</button>
                </div>

                <div class="validation-rules-list">
                    <h4 class="validation-rules-title">
                        📋 Validações Configuradas (${field.validationRules.length})
                    </h4>
                    <div id="rulesListContainer" class="rules-container">
                        ${renderValidationRulesList(field)}
                    </div>
                </div>
            `;

            // Setup event listener para mostrar/ocultar campo de parâmetro
            document.getElementById('validationType').addEventListener('change', function() {
                const paramGroup = document.getElementById('paramGroup');
                const paramLabel = document.getElementById('paramLabel');
                const value = this.value;
                
                if (value === 'minLength') {
                    paramGroup.style.display = 'block';
                    paramLabel.textContent = 'Tamanho Mínimo';
                } else if (value === 'maxLength') {
                    paramGroup.style.display = 'block';
                    paramLabel.textContent = 'Tamanho Máximo';
                } else if (value === 'exactLength') {
                    paramGroup.style.display = 'block';
                    paramLabel.textContent = 'Tamanho Exato';
                } else if (value === 'pattern') {
                    paramGroup.style.display = 'block';
                    paramLabel.textContent = 'Expressão Regular (regex)';
                } else {
                    paramGroup.style.display = 'none';
                }
            });

            // Adicionar listener de Enter nos campos de validação
            const validationMessage = document.getElementById('validationMessage');
            const validationParam = document.getElementById('validationParam');
            
            const handleEnter = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    addFieldValidation();
                }
            };
            
            validationMessage.addEventListener('keydown', handleEnter);
            validationParam.addEventListener('keydown', handleEnter);
        }

        function renderValidationRulesList(field) {
            if (field.validationRules.length === 0) {
                return '<div style="text-align: center; opacity: 0.5; padding: 10px;">Nenhuma validação configurada</div>';
            }

            return field.validationRules.map((rule, index) => {
                let paramInfo = '';
                if (rule.params !== null && rule.params !== undefined) {
                    if (typeof rule.params === 'number') {
                        paramInfo = ` (${rule.params})`;
                    } else if (typeof rule.params === 'string' && rule.type === 'pattern') {
                        paramInfo = ` (/${rule.params}/)`;
                    }
                }
                
                return `
                <div class="validation-rule-item">
                    <div class="rule-info">
                        <div class="rule-type">${getValidationTypeName(rule.type)}${paramInfo}</div>
                        <div class="rule-message">${rule.message}</div>
                    </div>
                    <div class="rule-actions">
                        <button class="btn btn-small" onclick="editFieldValidation(${index})" title="Editar validação">✏️</button>
                        <button class="btn btn-small danger" onclick="removeFieldValidation(${index})" title="Remover validação">🗑️</button>
                    </div>
                </div>
            `}).join('');
        }

        function getValidationTypeName(type) {
            const names = {
                'minLength': 'Tamanho Mínimo',
                'maxLength': 'Tamanho Máximo',
                'exactLength': 'Tamanho Exato',
                'numeric': 'Numérico',
                'alpha': 'Alfabético',
                'alphanumeric': 'Alfanumérico',
                'notZeros': 'Não pode ser Zeros',
                'notSpaces': 'Não pode ser Espaços',
                'email': 'Email',
                'cpf': 'CPF',
                'cnpj': 'CNPJ',
                'phone': 'Telefone',
                'date': 'Data',
                'pattern': 'Padrão (Regex)'
            };
            return names[type] || type;
        }

        function toggleFieldRequired() {
            const field = app.fields[selectedFieldIndex];
            field.isRequired = document.getElementById('fieldRequired').checked;
            renderFieldsList();
            showMessage('Campo ' + (field.isRequired ? 'marcado como obrigatório' : 'não é mais obrigatório'), 'success');
            updateCodePanel();
        }

        function updateBMSVariable() {
            if (selectedFieldIndex < 0 || selectedFieldIndex >= app.fields.length) return;
            
            const field = app.fields[selectedFieldIndex];
            const input = document.getElementById('bmsVariableName');
            field.bmsVariable = input.value.toUpperCase().trim();
            markDirty();
            renderFieldsList();
            
            if (field.bmsVariable) {
                showMessage(`Variável BMS definida: ${field.bmsVariable}`, 'success');
            }
            updateCodePanel();
        }

        function getBMSAttrString(field) {
            const attrs = [];
            
            // Proteção
            if (field.bmsAttributes.protection) {
                attrs.push(field.bmsAttributes.protection);
            }
            
            // Tipo (NUM ou NORM)
            if (field.bmsAttributes.type) {
                attrs.push(field.bmsAttributes.type);
            }
            
            // Intensidade (BRT, DRK - NORM já foi adicionado em type se aplicável)
            if (field.bmsAttributes.intensity && field.bmsAttributes.intensity !== 'NORM') {
                attrs.push(field.bmsAttributes.intensity);
            }
            
            // IC
            if (field.bmsAttributes.ic) {
                attrs.push('IC');
            }
            
            // FSET
            if (field.bmsAttributes.fset) {
                attrs.push('FSET');
            }
            
            // ASKIP (de outros atributos)
            if (field.bmsAttributes.askip) {
                attrs.push('ASKIP');
            }
            
            // Se não tem nenhum atributo, retorna NORM como padrão
            if (attrs.length === 0) {
                return 'NORM';
            }
            
            // Se só tem um atributo, retorna sem parênteses
            if (attrs.length === 1) {
                return attrs[0];
            }
            
            // Múltiplos atributos, retorna com parênteses
            return `(${attrs.join(',')})`;
        }

        function updateBMSAttributes(clickedElement) {
            if (selectedFieldIndex < 0 || selectedFieldIndex >= app.fields.length) return;
            
            const field = app.fields[selectedFieldIndex];
            
            // Se clicou em um checkbox de proteção, desmarcar os outros do MESMO grupo
            if (clickedElement && clickedElement.classList.contains('bmsProtection')) {
                document.querySelectorAll('input.bmsProtection').forEach(cb => {
                    if (cb !== clickedElement) cb.checked = false;
                });
            }
            
            // Se clicou em um checkbox de tipo, desmarcar os outros do MESMO grupo
            if (clickedElement && clickedElement.classList.contains('bmsType')) {
                document.querySelectorAll('input.bmsType').forEach(cb => {
                    if (cb !== clickedElement) cb.checked = false;
                });
            }
            
            // Se clicou em um checkbox de intensidade, desmarcar os outros do MESMO grupo
            if (clickedElement && clickedElement.classList.contains('bmsIntensity')) {
                document.querySelectorAll('input.bmsIntensity').forEach(cb => {
                    if (cb !== clickedElement) cb.checked = false;
                });
            }
            
            // NÃO desmarca nada entre grupos diferentes - cada grupo é independente
            
            // Construir preview com TODOS os selecionados
            const attrs = [];
            
            // Proteção
            const protectionCheckbox = document.querySelector('input.bmsProtection:checked');
            if (protectionCheckbox) {
                attrs.push(protectionCheckbox.value);
            }
            
            // Tipo de variável
            const typeCheckbox = document.querySelector('input.bmsType:checked');
            if (typeCheckbox) {
                attrs.push(typeCheckbox.value);
            }
            
            // Intensidade
            const intensityCheckbox = document.querySelector('input.bmsIntensity:checked');
            if (intensityCheckbox) {
                attrs.push(intensityCheckbox.value);
            }
            
            // IC
            const icCheckbox = document.getElementById('bmsIC');
            if (icCheckbox && icCheckbox.checked) {
                attrs.push('IC');
            }
            
            // FSET
            const fsetCheckbox = document.getElementById('bmsFSET');
            if (fsetCheckbox && fsetCheckbox.checked) {
                attrs.push('FSET');
            }
            
            // ASKIP
            const askipCheckbox = document.querySelector('input.bmsOther[value="ASKIP"]');
            if (askipCheckbox && askipCheckbox.checked) {
                attrs.push('ASKIP');
            }
            
            // Salvar TODOS os atributos no campo para usar no export
            field.bmsAttributes.protection = protectionCheckbox ? protectionCheckbox.value : null;
            field.bmsAttributes.type = typeCheckbox ? typeCheckbox.value : null;
            field.bmsAttributes.intensity = intensityCheckbox ? intensityCheckbox.value : null;
            field.bmsAttributes.ic = icCheckbox ? icCheckbox.checked : false;
            field.bmsAttributes.fset = fsetCheckbox ? fsetCheckbox.checked : false;
            field.bmsAttributes.askip = askipCheckbox ? askipCheckbox.checked : false;
            
            // Atualizar preview
            const preview = document.getElementById('bmsAttrPreview');
            if (preview) {
                if (attrs.length === 0) {
                    preview.textContent = '';
                } else if (attrs.length === 1) {
                    preview.textContent = attrs[0];
                } else {
                    preview.textContent = `(${attrs.join(',')})`;
                }
            }
            
            markDirty();
            saveToLocalStorage();
        }

        function copyFieldData(sourceIndex) {
            if (sourceIndex === '' || isNaN(sourceIndex)) {
                document.getElementById('copyFromField').value = '';
                return;
            }
            
            if (selectedFieldIndex < 0 || selectedFieldIndex >= app.fields.length) return;
            if (sourceIndex < 0 || sourceIndex >= app.fields.length) return;
            
            const targetField = app.fields[selectedFieldIndex];
            const sourceField = app.fields[sourceIndex];
            
            // Copiar apenas variável BMS (label é somente leitura)
            targetField.bmsVariable = sourceField.bmsVariable;
            
            // Atualizar interface
            renderFieldsList();
            renderFieldConfig();
            
            // Reset dropdown
            document.getElementById('copyFromField').value = '';
            
            showMessage(`Variável BMS copiada: ${sourceField.bmsVariable || '(vazio)'}`, 'success');
            updateCodePanel();
        }

        function addFieldValidation() {
            const field = app.fields[selectedFieldIndex];
            const type = document.getElementById('validationType').value;
            const message = document.getElementById('validationMessage').value;
            const paramInput = document.getElementById('validationParam');

            if (!type) {
                showMessage('Selecione um tipo de validação!', 'error');
                return;
            }

            if (!message) {
                showMessage('Digite uma mensagem de erro!', 'error');
                return;
            }

            let params = null;

            // Processar parâmetros conforme o tipo
            if (type === 'minLength' || type === 'maxLength' || type === 'exactLength') {
                params = parseInt(paramInput.value);
                if (isNaN(params)) {
                    showMessage('Digite um número válido!', 'error');
                    return;
                }
            } else if (type === 'pattern') {
                params = paramInput.value;
                if (!params) {
                    showMessage('Digite uma expressão regular!', 'error');
                    return;
                }
            }

            field.addValidation(type, params, message);
            markDirty();
            renderFieldConfig();
            renderFieldsList();
            showMessage('Validação adicionada com sucesso!', 'success');
            updateCodePanel();
        }

        function editFieldLabel(index) {
            const field = app.fields[index];
            const currentLabel = field.label || `Campo ${index + 1}`;
            
            const newLabel = prompt('Digite o novo nome para o campo:', currentLabel);
            
            if (newLabel !== null && newLabel.trim() !== '') {
                field.label = newLabel.trim();
                markDirty();
                renderFieldsList();
                if (selectedFieldIndex === index) {
                    renderFieldConfig();
                }
                showMessage('Nome do campo atualizado!', 'success');
                updateCodePanel();
            }
        }

        function editFieldValidation(index) {
            const field = app.fields[selectedFieldIndex];
            const rule = field.validationRules[index];
            
            if (!rule) return;
            
            // Preencher o formulário com os valores atuais
            document.getElementById('validationType').value = rule.type;
            document.getElementById('validationMessage').value = rule.message;
            
            // Mostrar campo de parâmetro se necessário
            const paramGroup = document.getElementById('paramGroup');
            const paramLabel = document.getElementById('paramLabel');
            const paramInput = document.getElementById('validationParam');
            
            if (rule.type === 'minLength') {
                paramGroup.style.display = 'block';
                paramLabel.textContent = 'Tamanho Mínimo';
                paramInput.value = rule.params || '';
            } else if (rule.type === 'maxLength') {
                paramGroup.style.display = 'block';
                paramLabel.textContent = 'Tamanho Máximo';
                paramInput.value = rule.params || '';
            } else if (rule.type === 'exactLength') {
                paramGroup.style.display = 'block';
                paramLabel.textContent = 'Tamanho Exato';
                paramInput.value = rule.params || '';
            } else if (rule.type === 'pattern') {
                paramGroup.style.display = 'block';
                paramLabel.textContent = 'Expressão Regular (regex)';
                paramInput.value = rule.params || '';
            } else {
                paramGroup.style.display = 'none';
                paramInput.value = '';
            }
            
            // Remover a validação antiga
            field.validationRules.splice(index, 1);
            renderFieldConfig();
            renderFieldsList();
            
            showMessage('Editando validação. Modifique os campos e clique em "Adicionar Validação".', 'info');
        }

        function removeFieldValidation(index) {
            const field = app.fields[selectedFieldIndex];
            field.validationRules.splice(index, 1);
            markDirty();
            renderFieldConfig();
            renderFieldsList();
            showMessage('Validação removida!', 'success');
            updateCodePanel();
        }

        function clearFieldValidations() {
            if (!confirm('Deseja realmente limpar todas as validações deste campo?')) return;
            
            const field = app.fields[selectedFieldIndex];
            field.validationRules = [];
            field.isRequired = false;
            markDirty();
            renderFieldConfig();
            renderFieldsList();
            showMessage('Todas as validações foram removidas!', 'success');
            updateCodePanel();
        }

        function showHelp() {
            document.getElementById('helpModalOverlay').classList.add('show');
        }

        function closeHelp() {
            document.getElementById('helpModalOverlay').classList.remove('show');
        }

        // Alternar Tema (Light/Dark)
        /* ════════════════════════════════════
           MOBILE DRAWERS
           ════════════════════════════════════ */
        function toggleMobileSidebar() {
            var sidebar  = document.querySelector('.ide-sidebar');
            var code     = document.querySelector('.ide-code-panel');
            var overlay  = document.getElementById('mobileOverlay');
            var isOpen   = sidebar.classList.toggle('mobile-open');
            if (isOpen) { code.classList.remove('mobile-open'); }
            overlay.classList.toggle('show', isOpen);
        }
        function toggleMobileCode() {
            var sidebar = document.querySelector('.ide-sidebar');
            var code    = document.querySelector('.ide-code-panel');
            var overlay = document.getElementById('mobileOverlay');
            var isOpen  = code.classList.toggle('mobile-open');
            if (isOpen) { sidebar.classList.remove('mobile-open'); }
            overlay.classList.toggle('show', isOpen);
        }
        function closeMobileDrawers() {
            document.querySelector('.ide-sidebar').classList.remove('mobile-open');
            document.querySelector('.ide-code-panel').classList.remove('mobile-open');
            document.getElementById('mobileOverlay').classList.remove('show');
        }

        function copyExampleTxt(btn) {
            const pre = document.getElementById('exampleTxtContent');
            if (!pre) return;
            navigator.clipboard.writeText(pre.textContent).then(function() {
                const original = btn.textContent;
                btn.textContent = '✅ Copiado!';
                btn.style.color = '#4ec9b0';
                btn.style.borderColor = '#4ec9b0';
                setTimeout(function() {
                    btn.textContent = original;
                    btn.style.color = '';
                    btn.style.borderColor = '';
                }, 2000);
            }).catch(function() {
                showMessage('Erro ao copiar. Selecione e copie manualmente.', 'error');
            });
        }

        // ════════════════════════════════════════════
        //  GUIDED TOUR
        // ════════════════════════════════════════════
        var _tourSpot = null, _tourTip = null, _tourIdx = 0;

        /* ── helpers para abrir drawers sem o overlay escuro do mobile ── */
        function _tourOpenSidebar() {
            var sb = document.querySelector('.ide-sidebar');
            var cp = document.querySelector('.ide-code-panel');
            if (sb) sb.classList.add('mobile-open');
            if (cp) cp.classList.remove('mobile-open');
        }
        function _tourOpenCode() {
            var sb = document.querySelector('.ide-sidebar');
            var cp = document.querySelector('.ide-code-panel');
            if (sb) sb.classList.remove('mobile-open');
            if (cp) cp.classList.add('mobile-open');
        }
        function _tourCloseDrawers() {
            var sb = document.querySelector('.ide-sidebar');
            var cp = document.querySelector('.ide-code-panel');
            var ov = document.getElementById('mobileOverlay');
            if (sb) sb.classList.remove('mobile-open');
            if (cp) cp.classList.remove('mobile-open');
            if (ov) ov.classList.remove('show');
        }
        function _tourSwitchSection(name) {
            document.querySelectorAll('.sidebar-section-panel').forEach(function(el) { el.classList.remove('active'); });
            document.querySelectorAll('.sidebar-panel-tab').forEach(function(btn) { btn.classList.remove('active'); });
            var panel = document.getElementById('section-' + name);
            if (panel) panel.classList.add('active');
            var label = name === 'projeto' ? 'Projeto' : name === 'atividade' ? 'Atividade' : "PF\u0027S";
            document.querySelectorAll('.sidebar-panel-tab').forEach(function(t) {
                if (t.textContent.trim() === label) t.classList.add('active');
            });
        }
        function _tourCloseAllModals() {
            // Modais que usam classList.add('show')
            ['fileModalOverlay','newScreenModalOverlay','exportModalOverlay',
             'importModalOverlay','validationExportModalOverlay','helpModalOverlay',
             'bmsOptionsModalOverlay','mappingModalOverlay'].forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.classList.remove('show');
            });
            // Painéis que usam style.display
            ['navPanelOverlay','camposPanelOverlay','configPanelOverlay'].forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.style.display = 'none';
            });
        }

        var _tourSteps = [
            /* ── 1. Ribbon geral ── */
            {
                sel: '.ide-titlebar-actions',
                pos: 'bottom',
                setup: function() { _tourCloseAllModals(); _tourCloseDrawers(); },
                title: '🛠 Barra de Ferramentas',
                text: 'A ribbon reúne todos os controles do editor. Cada grupo tem um rótulo abaixo: <b>Telas</b>, <b>Exportar / Importar</b>, <b>Painéis</b> e <b>Visual</b>. Os próximos passos mostrarão cada botão por dentro.'
            },
            /* ── 2. Carregar ── */
            {
                sel: '#dropZone',
                pos: 'bottom',
                setup: function() {
                    _tourCloseAllModals(); _tourCloseDrawers();
                    openFileModal();
                },
                title: '📂 Carregar Telas',
                text: 'Este é o painel de carregamento. Clique na área ou arraste arquivos <b>.txt</b> (layout 3270 com <code>x</code>=numérico e <code>z</code>=alfanumérico) ou <b>.bms</b>. Múltiplos arquivos de uma vez são suportados.'
            },
            /* ── 3. Nova Tela ── */
            {
                sel: '#newScreenNameInput',
                pos: 'bottom',
                setup: function() {
                    _tourCloseAllModals(); _tourCloseDrawers();
                    openNewScreenModal();
                },
                title: '➕ Criar Nova Tela',
                text: 'Digite aqui o nome da nova tela (até <b>8 caracteres</b>: letras e números). Exemplos: <code>MENU</code>, <code>CAD01</code>. Após confirmar, o editor de layout abre automaticamente para você compor o conteúdo da tela.'
            },
            /* ── 4. Demo ── */
            {
                sel: 'button[onclick="loadExampleScreen()"]',
                pos: 'bottom',
                setup: function() { _tourCloseAllModals(); _tourCloseDrawers(); },
                title: '▶️ Tela Demo',
                text: 'Carrega uma tela de demonstração pronta, com campos numéricos e alfanuméricos, para você explorar os recursos do editor sem precisar de um arquivo real. Ótimo ponto de partida!'
            },
            /* ── 5. Limpar ── */
            {
                sel: 'button[onclick="clearAllScreens()"]',
                pos: 'bottom',
                setup: function() { _tourCloseAllModals(); _tourCloseDrawers(); },
                title: '🗑️ Limpar Telas',
                text: 'Remove <b>todas</b> as telas carregadas e reinicia o projeto. Uma confirmação é exibida antes de apagar. Use com cuidado — esta ação não pode ser desfeita.'
            },
            /* ── 6. Salvar ── */
            {
                sel: 'button[onclick="saveProject()"]',
                pos: 'bottom',
                setup: function() { _tourCloseAllModals(); _tourCloseDrawers(); },
                title: '💾 Salvar Projeto',
                text: 'Grava o projeto atual no arquivo <b>.cics</b> da pasta selecionada. O indicador de status (•) na barra de título fica vermelho quando há alterações não salvas. Salve sempre antes de sair!'
            },
            /* ── 7. Exportar ── */
            {
                sel: '#exportModalOverlay .export-options',
                pos: 'bottom',
                setup: function() {
                    _tourCloseAllModals(); _tourCloseDrawers();
                    var el = document.getElementById('exportModalOverlay');
                    if (el) el.classList.add('show');
                },
                title: '📤 Exportar Regras de Navegação',
                text: 'Escolha o formato para exportar as regras de navegação: <b>JSON</b> para reimportar, <b>COBOL</b> com o EVALUATE/WHEN completo, <b>CSV</b> ou <b>Excel</b> para documentação da equipe.'
            },
            /* ── 8. Importar ── */
            {
                sel: '#importDropZone',
                pos: 'bottom',
                setup: function() {
                    _tourCloseAllModals(); _tourCloseDrawers();
                    var el = document.getElementById('importModalOverlay');
                    if (el) el.classList.add('show');
                },
                title: '📥 Importar Regras de Navegação',
                text: 'Arraste ou clique para carregar um arquivo de regras exportado anteriormente (<b>JSON</b>, <b>CSV</b> ou <b>Excel</b>). O sistema associa automaticamente as regras às telas pelo nome — telas não encontradas podem ser mapeadas manualmente.'
            },
            /* ── 9. Exp. Val. ── */
            {
                sel: '#validationExportModalOverlay .export-options',
                pos: 'bottom',
                setup: function() {
                    _tourCloseAllModals(); _tourCloseDrawers();
                    var el = document.getElementById('validationExportModalOverlay');
                    if (el) el.classList.add('show');
                },
                title: '📦 Exportar Validações e BMS',
                text: 'Exporte as configurações dos campos: <b>JSON</b> completo, <b>COBOL</b> com toda a lógica de validação, <b>Excel/CSV</b> para documentação, <b>BMS</b> (macros DFHMDF prontas) ou <b>Copybook</b> COBOL com definições de campos.'
            },
            /* ── 10. Config. ── */
            {
                sel: '#configPanelOverlay .modal-body',
                pos: 'left',
                setup: function() {
                    _tourCloseAllModals(); _tourCloseDrawers();
                    var el = document.getElementById('configPanelOverlay');
                    if (el) el.style.display = 'flex';
                },
                title: '⚙️ Configurações',
                text: 'Painel de configurações com três opções: <b>🌓 Alternar Tema</b> (claro/escuro, salvo no navegador); <b>📦 BMS / COBOL / Copybook</b> (exportação rápida de código); <b>🗺 Regras de Navegação</b> (exportar JSON).'
            },
            /* ── 11. Sidebar — lista de telas ── */
            {
                sel: '.screens-container',
                pos: 'right',
                setup: function() {
                    _tourCloseAllModals();
                    _tourSwitchSection('projeto');
                    if (window.innerWidth <= 767) _tourOpenSidebar();
                },
                title: '📋 Lista de Telas',
                text: 'Cada tela carregada aparece aqui no painel lateral. Clique em uma tela para visualizá-la no terminal. Use <b>🗑️</b> para excluir. A tela ativa fica destacada em azul.'
            },
            /* ── 12. Editar layout ── */
            {
                sel: '#btnEditScreen',
                pos: 'bottom',
                setup: function() { _tourCloseAllModals(); if (window.innerWidth <= 767) _tourCloseDrawers(); },
                title: '✏️ Editar Layout da Tela',
                text: 'Abre o editor de texto da tela ativa — uma área de <b>24 linhas × 80 colunas</b>. Digite o layout livremente usando <code>x</code> para campos numéricos e <code>z</code> para alfanuméricos. Ao clicar em <b>✅ Fechar Edição</b>, COBOL e BMS são regenerados.'
            },
            /* ── 13. Terminal ── */
            {
                sel: '.terminal-screen',
                pos: 'top',
                setup: function() { _tourCloseAllModals(); if (window.innerWidth <= 767) _tourCloseDrawers(); },
                title: '🖥 Terminal IBM 3270',
                text: 'Emulação exata do terminal 3270 — <b>24 linhas × 80 colunas</b>. Campos editáveis aparecem em <b>verde claro</b>. Clique em qualquer campo para selecioná-lo. No mobile, use a barra de controles abaixo para navegar entre campos.'
            },
            /* ── 14. PF'S ── */
            {
                sel: '.sidebar-pf-grid',
                pos: 'right',
                setup: function() {
                    _tourCloseAllModals();
                    _tourSwitchSection('custom');
                    if (window.innerWidth <= 767) _tourOpenSidebar();
                },
                title: '⌨️ Teclas de Função',
                text: 'Na aba <b>PF\'S</b> ficam as teclas PF1–PF12, ↑ PREV, ↓ NEXT e ENTER. Teclas com <b>borda verde</b> têm regras de navegação configuradas. Clique em qualquer tecla para simulá-la no terminal.'
            },
            /* ── 15. Navegação — dentro do painel ── */
            {
                sel: '#navPanelOverlay .modal',
                pos: 'right',
                setup: function() {
                    _tourCloseAllModals(); _tourCloseDrawers();
                    var el = document.getElementById('navPanelOverlay');
                    if (el) el.style.display = 'flex';
                },
                title: '🔀 Regras de Navegação',
                text: 'Este painel lista todas as regras de navegação da tela ativa. Cada regra define: <b>Tela de origem</b>, <b>Tecla PF</b> e <b>Ação</b> (navegar para outra tela, exibir mensagem, etc.). Clique em <b>Adicionar Regra</b> para criar uma nova. O COBOL é gerado automaticamente.'
            },
            /* ── 16. Campos — dentro do painel ── */
            {
                sel: '#camposPanelOverlay .modal',
                pos: 'right',
                setup: function() {
                    _tourCloseAllModals(); _tourCloseDrawers();
                    var el = document.getElementById('camposPanelOverlay');
                    if (el) el.style.display = 'flex';
                },
                title: '🔤 Campos e Validações',
                text: 'Este painel tem dois lados: à esquerda a <b>lista de campos</b> da tela (clique para selecionar) e à direita a <b>configuração</b> do campo: nome BMS, tipo, validações (obrigatório, tamanho mínimo, CPF, data, etc.). As teclas que disparam a validação são configuradas no topo (ENTER, PF1–PF12).'
            },
            /* ── 17. Código CICS ── */
            {
                sel: '#tabCics',
                pos: 'left',
                setup: function() {
                    _tourCloseAllModals();
                    switchCodeTab('cics');
                    if (window.innerWidth <= 767) _tourOpenCode();
                },
                title: '📑 Aba CICS/COBOL',
                text: 'A aba <b>CICS/COBOL</b> exibe o código completo do programa CICS — EVALUATE/WHEN para cada PF key, validações de campo, tratamento de mensagens e chamadas EXEC CICS — tudo gerado <b>em tempo real</b> conforme você edita.'
            },
            /* ── 18. BMS MAP ── */
            {
                sel: '#tabBms',
                pos: 'left',
                setup: function() {
                    _tourCloseAllModals();
                    switchCodeTab('bms');
                    if (window.innerWidth <= 767) _tourOpenCode();
                },
                title: '🗺 Aba BMS MAP',
                text: 'A aba <b>BMS MAP</b> exibe o source BMS com macros <code>DFHMSD</code>, <code>DFHMDI</code> e <code>DFHMDF</code> — nomes de até 8 caracteres, <code>POS</code>, <code>LENGTH</code> e <code>ATTRB</code>. Pronto para compilar com o assembler HLASM do z/OS.'
            },
            /* ── 19. Tour ── */
            {
                sel: 'button[onclick="startTour()"]',
                pos: 'bottom',
                setup: function() { _tourCloseAllModals(); _tourCloseDrawers(); },
                title: '🎯 Tour Interativo',
                text: 'Este botão reinicia o tour a qualquer momento. Use sempre que quiser rever uma funcionalidade ou apresentar o editor para alguém. O tour fecha automaticamente ao clicar em <b>✅ Concluir</b> ou <b>✕ Sair</b>.'
            },
            /* ── 20. Ajuda ── */
            {
                sel: '#helpModalOverlay .modal',
                pos: 'left',
                setup: function() {
                    _tourCloseAllModals(); _tourCloseDrawers();
                    if (typeof showHelp === 'function') showHelp();
                },
                title: '❓ Manual de Ajuda',
                text: 'O painel de ajuda contém o manual completo do editor: formato do arquivo TXT, atalhos de teclado, como criar regras de navegação, como configurar validações, exemplos de código BMS/COBOL e solução de problemas comuns.'
            },
            /* ── 21. Tema ── */
            {
                sel: 'button[onclick="toggleTheme()"]',
                pos: 'bottom',
                setup: function() { _tourCloseAllModals(); _tourCloseDrawers(); },
                title: '🌓 Alternar Tema',
                text: 'Muda entre <b>modo escuro</b> e <b>modo claro</b>. A preferência é salva no navegador — cada pessoa pode usar o tema que preferir. O modo claro facilita a leitura em ambientes bem iluminados.'
            }
        ];

        function startTour() {
            if (!_tourSpot) {
                _tourSpot = document.createElement('div');
                _tourSpot.className = 'tour-spotlight';
                document.body.appendChild(_tourSpot);
            }
            if (!_tourTip) {
                _tourTip = document.createElement('div');
                _tourTip.className = 'tour-tooltip';
                document.body.appendChild(_tourTip);
            }
            _tourSpot.style.display = 'block';
            _tourTip.style.display  = 'block';
            _tourIdx = 0;
            _tourShow(0);
        }

        function _tourGetEl(step) {
            var el = document.querySelector(step.sel);
            if (!el && step.fallback) el = document.querySelector(step.fallback);
            return el;
        }

        /* _tourShow: executa setup e aguarda reflow antes de posicionar */
        function _tourShow(idx) {
            var step = _tourSteps[idx];
            if (!step) { endTour(); return; }
            if (step.setup) {
                step.setup();
                /* no mobile o code-panel tem transition .28s; espera terminar */
                var delay = window.innerWidth <= 767 ? 320 : 60;
                setTimeout(function() { _tourPosition(idx); }, delay);
            } else {
                _tourPosition(idx);
            }
        }

        /* _tourPosition: mede o elemento e posiciona spotlight + tooltip */
        function _tourPosition(idx) {
            var step     = _tourSteps[idx];
            var el       = _tourGetEl(step);
            var isMobile = window.innerWidth <= 767;

            if (!el) {
                if (idx < _tourSteps.length - 1) { _tourShow(idx + 1); return; }
                else { endTour(); return; }
            }

            var pad = 7;
            var r   = el.getBoundingClientRect();

            /* visível na viewport? */
            var visible = r.width > 0 && r.height > 0 &&
                          r.right  > 0 && r.left < window.innerWidth &&
                          r.bottom > 0 && r.top  < window.innerHeight;

            if (visible) {
                _tourSpot.style.top    = (r.top    - pad) + 'px';
                _tourSpot.style.left   = (r.left   - pad) + 'px';
                _tourSpot.style.width  = (r.width  + pad * 2) + 'px';
                _tourSpot.style.height = (r.height + pad * 2) + 'px';
            } else {
                /* elemento fora da viewport (drawer fechado, etc.) — esconde spotlight */
                _tourSpot.style.top    = '-9999px';
                _tourSpot.style.left   = '-9999px';
                _tourSpot.style.width  = '0';
                _tourSpot.style.height = '0';
            }

            var isLast  = idx === _tourSteps.length - 1;
            var isFirst = idx === 0;
            _tourTip.innerHTML =
                '<div class="tour-tip-title">' + step.title + '</div>' +
                '<div class="tour-tip-text">'  + step.text  + '</div>' +
                '<div class="tour-tip-footer">' +
                    '<span class="tour-step-count">' + (idx + 1) + ' / ' + _tourSteps.length + '</span>' +
                    '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">' +
                        '<button class="tour-btn tour-btn-skip"  onclick="endTour()">\u2715 Sair</button>' +
                        (!isFirst ? '<button class="tour-btn tour-btn-prev" onclick="_tourShow(' + (idx - 1) + ')">\u2190 Anterior</button>' : '') +
                        '<button class="tour-btn tour-btn-next" onclick="' + (isLast ? 'endTour()' : '_tourShow(' + (idx + 1) + ')') + '">' +
                            (isLast ? '\u2705 Concluir' : 'Pr\u00f3ximo \u2192') +
                        '</button>' +
                    '</div>' +
                '</div>';

            _tourTip.style.display = 'block';
            var vw = window.innerWidth, vh = window.innerHeight;

            if (isMobile) {
                /* celular: painel fixo na parte inferior */
                _tourTip.style.width    = (vw - 16) + 'px';
                _tourTip.style.left     = '8px';
                _tourTip.style.top      = '';
                _tourTip.style.bottom   = '10px';
                _tourTip.style.position = 'fixed';
            } else {
                /* desktop: posicionamento inteligente ao redor do elemento */
                _tourTip.style.bottom   = '';
                _tourTip.style.position = '';
                var tw = 300, pad2 = 14;
                var th = _tourTip.offsetHeight || 180;
                var t, l;
                if (step.pos === 'right')       { l = r.right  + pad2;                t = r.top + r.height / 2 - th / 2; }
                else if (step.pos === 'left')   { l = r.left   - tw - pad2;            t = r.top + r.height / 2 - th / 2; }
                else if (step.pos === 'bottom') { l = r.left   + r.width / 2 - tw / 2; t = r.bottom + pad2; }
                else                            { l = r.left   + r.width / 2 - tw / 2; t = r.top - th - pad2; }
                l = Math.max(8, Math.min(l, vw - tw - 8));
                t = Math.max(8, Math.min(t, vh - th - 8));
                _tourTip.style.left = l + 'px';
                _tourTip.style.top  = t + 'px';
            }
            _tourIdx = idx;
        }

        function endTour() {
            if (_tourSpot) _tourSpot.style.display = 'none';
            if (_tourTip)  _tourTip.style.display  = 'none';
            /* fechar drawers mobile e modais que o tour possa ter aberto */
            _tourCloseAllModals();
            _tourCloseDrawers();
        }

        // ════════════════════════════════════════════
        //  TOUR BÁSICO  (Carregar → Terminal → BMS → Exportar)
        // ════════════════════════════════════════════
        var _basicTourSteps = [
            {
                sel: 'button[onclick="openFileModal()"]',
                pos: 'bottom',
                setup: function() { _tourCloseAllModals(); _tourCloseDrawers(); },
                title: '1️⃣ Carregar arquivo TXT',
                text: 'Toque em <b>Carregar</b> para abrir o seletor de arquivos.<br>Selecione um arquivo <code>.txt</code> ou <code>.bms</code> com o layout da sua tela CICS 3270. Você pode carregar vários de uma vez!'
            },
            {
                sel: '#terminal',
                pos: 'top',
                setup: function() { _tourCloseAllModals(); _tourCloseDrawers(); },
                title: '2️⃣ Visualizar no Terminal',
                text: 'Após carregar, a tela aparece aqui no <b>Terminal CICS 3270</b>, exatamente como seria no mainframe — 24 linhas × 80 colunas. Clique nas telas da barra lateral para alternar entre elas.'
            },
            {
                sel: '#tabBms',
                pos: 'left',
                setup: function() {
                    _tourCloseAllModals();
                    switchCodeTab('bms');
                    if (window.innerWidth <= 767) _tourOpenCode();
                },
                title: '3️⃣ Ver o BMS gerado',
                text: 'Clique na aba <b>BMS MAP</b> para ver o source BMS completo com as macros <code>DFHMSD</code>, <code>DFHMDI</code> e <code>DFHMDF</code> — gerado automaticamente a partir do seu arquivo TXT, pronto para o assembler HLASM.'
            },
            {
                sel: 'button[onclick="openValidationExportModal()"]',
                pos: 'bottom',
                setup: function() {
                    _tourCloseAllModals();
                    if (window.innerWidth <= 767) _tourCloseDrawers();
                },
                title: '4️⃣ Exportar o BMS',
                text: 'Clique em <b>Exp. Val.</b> para baixar o BMS MAP gerado. Escolha o formato — JSON, COBOL, SQL ou <b>BMS direto</b>. O arquivo fica pronto para usar no seu projeto z/OS!'
            }
        ];

        // ════════════════════════════════════════════
        //  MODAL TELA DE EXEMPLO  (mostrar antes do tour básico)
        // ════════════════════════════════════════════
        function showSampleTxtModal() {
            var SAMPLE =
'                                                                                ' + '\n' +
'MENU01   SISTEMA DE CADASTRO DE CLIENTES          DATA: 99/99/9999' + '\n' +
'--------------------------------------------------------------------------------' + '\n' +
' NOME.........: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx                                ' + '\n' +
' CPF/CNPJ.....: xxxxxxxxxxxxxxx                                                 ' + '\n' +
' TELEFONE.....: xxxxxxxxxxx                                                     ' + '\n' +
' E-MAIL.......: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx                       ' + '\n' +
' ENDERECO.....: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx                               ' + '\n' +
' CIDADE.......: xxxxxxxxxxxxxxxxxx    ESTADO: xx    CEP: xxxxxxxx               ' + '\n' +
'                                                                                ' + '\n' +
'--------------------------------------------------------------------------------' + '\n' +
' MENSAGEM.: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx               ' + '\n' +
'                                                                                ' + '\n' +
' PF3=RETORNAR    PF5=CONFIRMAR    PF7=ANTERIOR    PF8=PROXIMO                  ';

            /* cria estilos do modal de exemplo */
            if (!document.getElementById('sampleTxtStyle')) {
                var s = document.createElement('style');
                s.id = 'sampleTxtStyle';
                s.textContent =
                    '#sampleTxtOverlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:5100;display:flex;align-items:center;justify-content:center;padding:12px;}' +
                    '#sampleTxtBox{background:#1e1e1e;border:1px solid #3f3f46;width:min(720px,100%);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.7);border-radius:4px;overflow:hidden;}' +
                    '#sampleTxtBox .stb-header{background:#3c3c3c;padding:10px 14px;font-size:13px;font-weight:700;color:#fff;border-bottom:1px solid #555;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:8px;}' +
                    '#sampleTxtBox .stb-header-left{display:flex;align-items:center;gap:8px;}' +
                    '#sampleTxtBox .stb-legend{padding:8px 14px;background:#252526;border-bottom:1px solid #3f3f46;font-size:11px;color:#aaa;display:flex;gap:16px;flex-wrap:wrap;flex-shrink:0;}' +
                    '#sampleTxtBox .stb-legend span{display:flex;align-items:center;gap:5px;}' +
                    '#sampleTxtBox .stb-legend code{background:#3c3c3c;padding:1px 5px;border-radius:2px;font-family:"IBM Plex Mono",monospace;font-size:11px;}' +
                    '#sampleTxtBox .stb-pre{flex:1;overflow:auto;margin:0;padding:12px 16px;font-family:"IBM Plex Mono","Courier New",monospace;font-size:12px;line-height:1.55;color:#d4d4d4;background:#1e1e1e;white-space:pre;tab-size:1;}' +
                    '#sampleTxtBox .stb-pre .stb-field{color:#4ec9b0;}' +
                    '#sampleTxtBox .stb-pre .stb-label{color:#cccccc;}' +
                    '#sampleTxtBox .stb-pre .stb-sep{color:#555;}' +
                    '#sampleTxtBox .stb-pre .stb-pf{color:#c586c0;}' +
                    '#sampleTxtBox .stb-footer{background:#252526;padding:10px 14px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #3f3f46;flex-wrap:wrap;flex-shrink:0;}' +
                    '#sampleTxtBox .stb-btn{font-family:inherit;font-size:13px;padding:9px 20px;border:none;cursor:pointer;border-radius:3px;touch-action:manipulation;-webkit-tap-highlight-color:transparent;flex:1;min-width:120px;text-align:center;}' +
                    '#sampleTxtBox .stb-btn-copy{background:#007acc;color:#fff;}' +
                    '#sampleTxtBox .stb-btn-copy:active{background:#1a8ad4;}' +
                    '#sampleTxtBox .stb-btn-next{background:#3c3c3c;color:#ccc;border:1px solid #555;}' +
                    '#sampleTxtBox .stb-btn-next:active{background:#505050;}' +
                    '#sampleTxtBox .stb-subtitle{padding:8px 14px 6px;background:#1e3a4a;border-bottom:1px solid #1f5f78;font-size:12px;color:#7dd3f0;display:block;flex-shrink:0;line-height:1.5;}' +
                    '#sampleTxtBox .stb-sub-short{display:none;}' +
                    '@media(min-width:480px){#sampleTxtBox .stb-btn{flex:none;}}' +
                    '@media(max-width:479px){' +
                        '#sampleTxtOverlay{padding:0 !important;align-items:flex-end;}' +
                        '#sampleTxtBox .stb-sub-full{display:none;}' +
                        '#sampleTxtBox .stb-sub-short{display:inline;}' +
                        '#sampleTxtBox{width:100% !important;max-height:92dvh;border-radius:12px 12px 0 0;border-left:none;border-right:none;border-bottom:none;}' +
                        '#sampleTxtBox .stb-header{font-size:11px;padding:8px 10px;}' +
                        '#sampleTxtBox .stb-subtitle{font-size:10px;padding:5px 10px;line-height:1.35;}' +
                        '#sampleTxtBox .stb-legend{padding:5px 10px;gap:6px;font-size:10px;}' +
                        '#sampleTxtBox .stb-legend code{font-size:10px;}' +
                        '#sampleTxtBox .stb-pre{font-size:9.5px;padding:8px 10px;line-height:1.45;}' +
                        '#sampleTxtBox .stb-footer{padding:8px 10px;}' +
                        '#sampleTxtBox .stb-btn{font-size:12px;padding:10px 12px;flex:1;}' +
                    '}';  
                document.head.appendChild(s);
            }

            /* coloriza o conteúdo */
            function colorize(txt) {
                return txt.split('\n').map(function(line) {
                    if (/^[-=─]+$/.test(line.trim()) || line.trim() === '') {
                        return '<span class="stb-sep">' + _esc(line) + '</span>';
                    }
                    if (/PF\d+=/.test(line)) {
                        return '<span class="stb-pf">' + _esc(line) + '</span>';
                    }
                    /* destaca os campos (sequências de x) em ciano */
                    return _esc(line).replace(/(x+)/g, '<span class="stb-field">$1</span>');
                }).join('\n');
            }
            function _esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

            var overlay = document.createElement('div');
            overlay.id = 'sampleTxtOverlay';
            overlay.innerHTML =
                '<div id="sampleTxtBox">' +
                    '<div class="stb-header">' +
                        '<div class="stb-header-left">📄 Exemplo de arquivo TXT — tela CICS 3270</div>' +
                    '</div>' +
                    '<div class="stb-subtitle">' +
                        '<span class="stb-sub-full">📋 Copie o conteúdo abaixo, salve como arquivo <strong>.TXT</strong> e carregue no editor para gerar o BMS</span>' +
                        '<span class="stb-sub-short">📋 Copie, salve como <strong>.TXT</strong> e carregue no editor</span>' +
                    '</div>' +
                    '<div class="stb-legend">' +
                        '<span><code style="color:#4ec9b0;">xxx</code> = campo editável (alfanumérico)</span>' +
                        '<span><code style="color:#c586c0;">PF3=...</code> = tecla de função</span>' +
                        '<span><code>---</code> = separador / texto estático</span>' +
                    '</div>' +
                    '<pre class="stb-pre" id="sampleTxtPre">' + colorize(SAMPLE) + '</pre>' +
                    '<div class="stb-footer">' +
                        '<button class="stb-btn stb-btn-next" id="stbSkip">Pular → iniciar tour</button>' +
                        '<button class="stb-btn stb-btn-copy" id="stbCopy">📋 Copiar exemplo</button>' +
                    '</div>' +
                '</div>';
            document.body.appendChild(overlay);

            function closeSample() {
                overlay.remove();
                setTimeout(startBasicTour, 150);
            }

            document.getElementById('stbCopy').addEventListener('click', function() {
                var btn = this;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(SAMPLE).then(function() {
                        btn.textContent = '✅ Copiado!';
                        setTimeout(function() { btn.innerHTML = '📋 Copiar exemplo'; }, 2000);
                    });
                } else {
                    /* fallback legado */
                    var ta = document.createElement('textarea');
                    ta.value = SAMPLE;
                    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                    btn.textContent = '✅ Copiado!';
                    setTimeout(function() { btn.innerHTML = '📋 Copiar exemplo'; }, 2000);
                }
            });

            document.getElementById('stbSkip').addEventListener('click', closeSample);
        }

        function startBasicTour() {
            /* encerra tour completo se estiver ativo */
            if (_tourSpot) _tourSpot.style.display = 'none';
            if (_tourTip)  _tourTip.style.display  = 'none';

            if (!_tourSpot) {
                _tourSpot = document.createElement('div');
                _tourSpot.className = 'tour-spotlight';
                document.body.appendChild(_tourSpot);
            }
            if (!_tourTip) {
                _tourTip = document.createElement('div');
                _tourTip.className = 'tour-tooltip';
                document.body.appendChild(_tourTip);
            }

            /* substitui temporariamente os passos */
            var _saved = _tourSteps;
            _tourSteps = _basicTourSteps;
            _tourSpot.style.display = 'block';
            _tourTip.style.display  = 'block';
            _tourIdx = 0;
            _tourShow(0);

            /* restaura os passos originais quando o tour encerrar */
            var _origEnd = endTour;
            endTour = function() {
                _origEnd();
                _tourSteps = _saved;
                endTour = _origEnd;
            };
        }

        // ════════════════════════════════════════════
        //  MODAL DE BOAS-VINDAS  (aparece sempre ao carregar)
        // ════════════════════════════════════════════
        (function initWelcomeTour() {

            /* cria os estilos — responsivo mobile incluso */
            var style = document.createElement('style');
            style.textContent =
                '#welcomeTourOverlay{position:fixed;inset:0;background:rgba(0,0,0,.70);z-index:5000;display:flex;align-items:center;justify-content:center;padding:12px;}' +
                '#welcomeTourBox{background:#2d2d30;border:1px solid #3f3f46;width:min(460px,100%);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.7);border-radius:4px;overflow:hidden;}' +
                '#welcomeTourBox .wtb-header{background:#3c3c3c;padding:12px 16px;font-size:14px;font-weight:700;color:#fff;border-bottom:1px solid #3f3f46;display:flex;align-items:center;gap:8px;flex-shrink:0;}' +
                '#welcomeTourBox .wtb-body{padding:18px 16px;font-size:13px;color:#cccccc;line-height:1.6;overflow-y:auto;flex:1;}' +
                '#welcomeTourBox .wtb-body b{color:#fff;}' +
                '#welcomeTourBox .wtb-steps{margin:14px 0 0;display:flex;flex-direction:column;gap:8px;}' +
                '#welcomeTourBox .wtb-step{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:#ccc;}' +
                '#welcomeTourBox .wtb-step-num{background:#007acc;color:#fff;border-radius:50%;width:22px;height:22px;min-width:22px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px;}' +
                '#welcomeTourBox .wtb-footer{background:#252526;padding:12px 16px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #3f3f46;flex-wrap:wrap;flex-shrink:0;}' +
                '#welcomeTourBox .wtb-btn{font-family:inherit;font-size:13px;padding:10px 22px;border:none;cursor:pointer;border-radius:3px;touch-action:manipulation;-webkit-tap-highlight-color:transparent;flex:1;min-width:120px;text-align:center;}' +
                '#welcomeTourBox .wtb-btn-yes{background:#007acc;color:#fff;}' +
                '#welcomeTourBox .wtb-btn-yes:active{background:#1a8ad4;}' +
                '#welcomeTourBox .wtb-btn-no{background:#3c3c3c;color:#ccc;border:1px solid #555;}' +
                '#welcomeTourBox .wtb-btn-no:active{background:#505050;}' +
                '@media(min-width:480px){#welcomeTourBox .wtb-btn{flex:none;}}';
            document.head.appendChild(style);

            var overlay = document.createElement('div');
            overlay.id = 'welcomeTourOverlay';
            overlay.innerHTML =
                '<div id="welcomeTourBox">' +
                    '<div class="wtb-header">🖥️ CICS COBOL Editor — Bem-vindo!</div>' +
                    '<div class="wtb-body">' +
                        'Quer ver um <b>tour rápido</b> de como usar o editor?' +
                        '<div class="wtb-steps">' +
                            '<div class="wtb-step"><div class="wtb-step-num">1</div><span>Carregar um arquivo <b>TXT / BMS</b> com sua tela</span></div>' +
                            '<div class="wtb-step"><div class="wtb-step-num">2</div><span>Visualizar a tela no <b>Terminal 3270</b></span></div>' +
                            '<div class="wtb-step"><div class="wtb-step-num">3</div><span>Ver o <b>BMS MAP</b> gerado automaticamente</span></div>' +
                            '<div class="wtb-step"><div class="wtb-step-num">4</div><span><b>Exportar</b> o BMS pronto para o z/OS</span></div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="wtb-footer">' +
                        '<button class="wtb-btn wtb-btn-no"  id="wtbNo">Não, obrigado</button>' +
                        '<button class="wtb-btn wtb-btn-yes" id="wtbYes">▶ Sim, mostrar tour!</button>' +
                    '</div>' +
                '</div>';
            document.body.appendChild(overlay);

            function closeWelcome() {
                overlay.remove();
            }

            document.getElementById('wtbYes').addEventListener('click', function() {
                closeWelcome();
                setTimeout(showSampleTxtModal, 200);
            });
            document.getElementById('wtbNo').addEventListener('click', closeWelcome);
        }());

        function toggleTheme() {
            const body = document.body;
            const isLight = body.classList.toggle('light-theme');
            
            // Salvar preferência no localStorage
            localStorage.setItem('theme', isLight ? 'light' : 'dark');
            
            // Mostrar mensagem
            showMessage(isLight ? 'Tema Moderno Light ativado! ☀️' : 'Tema Mainframe Dark ativado! 🌑', 'success');
        }

        // Carregar tema salvo ao iniciar
        function loadSavedTheme() {
            const savedTheme = localStorage.getItem('theme');
            if (savedTheme === 'light') {
                document.body.classList.add('light-theme');
            }
        }

        // Chamar ao carregar a página
        document.addEventListener('DOMContentLoaded', loadSavedTheme);

        // Exportação de Regras de Navegação
        function openExportModal() {
            if (app.navigationRules.length === 0) {
                showMessage('Nenhuma regra de navegação para exportar!', 'error');
                return;
            }
            document.getElementById('exportModalOverlay').classList.add('show');
        }

        function closeExportModal() {
            document.getElementById('exportModalOverlay').classList.remove('show');
        }

        // Exportação de Validações
        function openValidationExportModal() {
            if (app.screens.length === 0) {
                showMessage('Carregue pelo menos uma tela antes de exportar validações!', 'error');
                return;
            }
            document.getElementById('validationExportModalOverlay').classList.add('show');
        }

        function closeValidationExportModal() {
            document.getElementById('validationExportModalOverlay').classList.remove('show');
        }

        function openBMSExportOptions() {
            if (app.currentScreenIndex < 0 || app.currentScreenIndex >= app.screens.length) {
                showMessage('Selecione uma tela antes de exportar BMS!', 'error');
                return;
            }
            var scopeCurrent = document.getElementById('bmsExportScopeCurrent');
            var scopeAll     = document.getElementById('bmsExportScopeAll');
            var scopeAllText = document.getElementById('bmsExportScopeAllText');
            var count        = app.screens.length;

            // Resetar para "apenas este mapa"
            if (scopeCurrent) scopeCurrent.checked = true;
            if (scopeAll)     scopeAll.disabled = (count <= 1);
            if (scopeAllText) scopeAllText.textContent = 'Todos os mapas' + (count > 1 ? ' (' + count + ')' : ' (apenas 1)');

            // Preencher checklist de mapas
            var items = document.getElementById('bmsExportMapItems');
            if (items) {
                items.innerHTML = '';
                app.screens.forEach(function(s, idx) {
                    var chk = document.createElement('label');
                    chk.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#222;';
                    var inp = document.createElement('input');
                    inp.type = 'checkbox';
                    inp.value = String(idx);
                    inp.checked = true;
                    inp.id = 'bmsMapChk_' + idx;
                    var span = document.createElement('span');
                    span.textContent = s.name + (s.bmsImported ? ' (importado)' : '');
                    chk.appendChild(inp);
                    chk.appendChild(span);
                    items.appendChild(chk);
                });
            }

            // Ocultar checklist (começa no modo "atual")
            var mapList = document.getElementById('bmsExportMapList');
            if (mapList) mapList.style.display = 'none';

            document.getElementById('validationExportModalOverlay').classList.remove('show');
            document.getElementById('bmsOptionsModalOverlay').classList.add('show');
        }

        function bmsExportScopeChanged() {
            var all     = document.getElementById('bmsExportScopeAll');
            var mapList = document.getElementById('bmsExportMapList');
            if (mapList) mapList.style.display = (all && all.checked) ? '' : 'none';
        }

        function bmsExportCheckAll(state) {
            var items = document.getElementById('bmsExportMapItems');
            if (!items) return;
            items.querySelectorAll('input[type=checkbox]').forEach(function(c) { c.checked = state; });
        }

        function closeBMSOptionsModal() {
            document.getElementById('bmsOptionsModalOverlay').classList.remove('show');
        }

        // Importação de Regras
        let pendingImportData = null;

        function openImportModal() {
            console.log('Abrindo modal de importação...');
            console.log('Telas carregadas:', app.screens.length);
            
            if (app.screens.length === 0) {
                showMessage('Carregue pelo menos uma tela antes de importar regras!', 'error');
                return;
            }
            
            document.getElementById('importModalOverlay').classList.add('show');
            document.getElementById('importPreview').style.display = 'none';
            pendingImportData = null;
        }

        function closeImportModal() {
            document.getElementById('importModalOverlay').classList.remove('show');
            document.getElementById('importPreview').style.display = 'none';
            pendingImportData = null;
        }

        function selectImportFile() {
            console.log('Selecionando arquivo de importação...');
            const input = document.getElementById('importFileInput');
            console.log('Input encontrado:', input ? 'SIM' : 'NÃO');
            if (input) {
                input.value = ''; // Limpar para permitir selecionar o mesmo arquivo novamente
                input.click();
            }
        }

        function handleImportFile(e) {
            console.log('Arquivo selecionado:', e.target.files[0]?.name);
            const file = e.target.files[0];
            if (file) {
                processImportFile(file);
            }
            // Limpar o input após processar
            e.target.value = '';
        }

        async function processImportFile(file) {
            console.log('Processando arquivo:', file.name);
            showLoader();
            
            try {
                const content = await readFile(file);
                console.log('Conteúdo lido, tamanho:', content.length);
                
                const fileName = file.name.toLowerCase();
                let importedRules = [];

                if (fileName.endsWith('.json')) {
                    console.log('Parseando JSON...');
                    importedRules = parseJSONRules(content);
                } else if (fileName.endsWith('.csv')) {
                    console.log('Parseando CSV...');
                    importedRules = parseCSVRules(content);
                } else if (fileName.endsWith('.xls') || fileName.endsWith('.xlsx')) {
                    console.log('Parseando Excel...');
                    importedRules = parseExcelRules(content);
                } else {
                    throw new Error('Formato de arquivo não suportado: ' + fileName);
                }

                console.log('Regras importadas:', importedRules.length);

                if (importedRules.length === 0) {
                    throw new Error('Nenhuma regra encontrada no arquivo');
                }

                pendingImportData = importedRules;
                displayImportPreview(importedRules);
                hideLoader();
                
            } catch (error) {
                console.error('Erro ao processar arquivo:', error);
                hideLoader();
                showMessage(`Erro ao processar arquivo: ${error.message}`, 'error');
            }
        }

        function parseJSONRules(content) {
            const data = JSON.parse(content);
            const rules = data.navigationRules || data.rules || data;
            
            return rules.map(rule => ({
                fromScreen: rule.fromScreen || rule.from_screen || rule.FromScreen,
                toScreen: rule.toScreen || rule.to_screen || rule.ToScreen,
                key: rule.key || rule.pfKey || rule.pf_key || rule.Key,
                action: rule.action || rule.Action || 'navigate',
                message: rule.message || rule.Message || ''
            }));
        }

        function parseCSVRules(content) {
            const lines = content.split('\n').filter(l => l.trim());
            const rules = [];
            
            // Ignorar cabeçalho
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                // Parse CSV (considerando valores entre aspas)
                const values = [];
                let current = '';
                let inQuotes = false;
                
                for (let char of line) {
                    if (char === '"') {
                        inQuotes = !inQuotes;
                    } else if (char === ',' && !inQuotes) {
                        values.push(current.trim());
                        current = '';
                    } else {
                        current += char;
                    }
                }
                values.push(current.trim());
                
                if (values.length >= 5) {
                    const actionText = values[4].toLowerCase();
                    const action = actionText.includes('naveg') ? 'navigate' : 'message';
                    
                    rules.push({
                        fromScreen: values[1],
                        toScreen: values[2],
                        key: values[3],
                        action: action,
                        message: values[5] || ''
                    });
                }
            }
            
            return rules;
        }

        function parseExcelRules(content) {
            // Para arquivos Excel XML, fazer parse do XML
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(content, 'text/xml');
            const rows = xmlDoc.querySelectorAll('Row');
            const rules = [];
            
            // Ignorar primeira linha (cabeçalho)
            for (let i = 1; i < rows.length; i++) {
                const cells = rows[i].querySelectorAll('Cell Data');
                if (cells.length >= 5) {
                    const values = Array.from(cells).map(cell => cell.textContent.trim());
                    const actionText = values[4].toLowerCase();
                    const action = actionText.includes('naveg') ? 'navigate' : 'message';
                    
                    rules.push({
                        fromScreen: values[1],
                        toScreen: values[2],
                        key: values[3],
                        action: action,
                        message: values[5] || ''
                    });
                }
            }
            
            return rules;
        }

        function displayImportPreview(rules) {
            const container = document.getElementById('importPreviewContent');
            let html = `<div style="margin-bottom: 15px; color: #00ff00;">
                <strong>Total de regras no arquivo:</strong> ${rules.length}<br>
                <strong>Telas disponíveis no sistema:</strong> ${app.screens.length}
            </div>`;
            
            html += '<table style="width: 100%; border-collapse: collapse; font-size: 11px;">';
            html += '<thead><tr style="background: #003300;">';
            html += '<th style="padding: 8px; border: 1px solid #00ff00;">Tela Origem</th>';
            html += '<th style="padding: 8px; border: 1px solid #00ff00;">Tela Destino</th>';
            html += '<th style="padding: 8px; border: 1px solid #00ff00;">Tecla</th>';
            html += '<th style="padding: 8px; border: 1px solid #00ff00;">Ação</th>';
            html += '<th style="padding: 8px; border: 1px solid #00ff00;">Status</th>';
            html += '</tr></thead><tbody>';
            
            rules.forEach(rule => {
                const fromExists = app.screens.some(s => s.name === rule.fromScreen);
                const toExists = rule.action === 'navigate' ? app.screens.some(s => s.name === rule.toScreen) : true;
                const status = fromExists && toExists ? '✅ OK' : '⚠️ Tela não encontrada';
                const statusColor = fromExists && toExists ? '#00ff00' : '#ff9800';
                
                html += `<tr style="border-bottom: 1px solid #003300;">`;
                html += `<td style="padding: 8px;">${rule.fromScreen}</td>`;
                html += `<td style="padding: 8px;">${rule.toScreen || '-'}</td>`;
                html += `<td style="padding: 8px; text-align: center;">${rule.key}</td>`;
                html += `<td style="padding: 8px; text-align: center;">${rule.action === 'navigate' ? 'Navegar' : rule.action === 'navigate_msg' ? 'Navegar + Msg' : 'Mensagem'}</td>`;
                html += `<td style="padding: 8px; text-align: center; color: ${statusColor};">${status}</td>`;
                html += `</tr>`;
            });
            
            html += '</tbody></table>';
            
            container.innerHTML = html;
            document.getElementById('importPreview').style.display = 'block';
        }

        function confirmImport() {
            if (!pendingImportData) return;
            
            let imported = 0;
            let needsMapping = [];
            
            pendingImportData.forEach(rule => {
                const fromScreen = app.screens.find(s => s.name === rule.fromScreen);
                const toScreen = app.screens.find(s => s.name === rule.toScreen);
                
                // Verificar se já existe regra idêntica
                const exists = app.navigationRules.some(r => 
                    r.fromScreen === fromScreen?.id && 
                    r.key === rule.key && 
                    r.action === rule.action
                );
                
                if (exists) {
                    return; // Pular duplicatas
                }
                
                // Importar regra mesmo sem telas encontradas
                const newRule = {
                    id: Date.now() + Math.random(),
                    fromScreen: fromScreen?.id || null,
                    toScreen: toScreen?.id || null,
                    key: rule.key,
                    action: rule.action,
                    message: rule.message || '',
                    // Guardar nomes originais para associação manual
                    originalFromScreenName: rule.fromScreen,
                    originalToScreenName: rule.toScreen,
                    needsMapping: !fromScreen || (rule.action === 'navigate' && !toScreen)
                };
                
                app.navigationRules.push(newRule);
                imported++;
                
                if (newRule.needsMapping) {
                    needsMapping.push(newRule);
                }
            });
            
            renderNavigationRules();
            updatePFKeysLabels();
            closeImportModal();
            
            if (needsMapping.length > 0) {
                showMessage(`✅ ${imported} regra(s) importada(s). ${needsMapping.length} precisa(m) de associação manual.`, 'info');
                // Abrir modal de associação após 1 segundo
                setTimeout(() => openMappingModal(), 1000);
            } else {
                showMessage(`✅ ${imported} regra(s) importada(s) com sucesso!`, 'success');
            }
        }

        // Modal de Associação Manual de Telas
        function openMappingModal() {
            const unmappedRules = app.navigationRules.filter(r => r.needsMapping);
            
            if (unmappedRules.length === 0) {
                showMessage('Todas as regras já estão associadas!', 'success');
                return;
            }
            
            renderMappingList(unmappedRules);
            document.getElementById('mappingModalOverlay').classList.add('show');
        }

        function closeMappingModal() {
            document.getElementById('mappingModalOverlay').classList.remove('show');
        }

        function renderMappingList(rules) {
            const container = document.getElementById('mappingList');
            let html = '';
            
            rules.forEach((rule, index) => {
                const needsFrom = !rule.fromScreen || rule.fromScreen === 0 || typeof rule.fromScreen === 'undefined';
                const needsTo = (rule.action === 'navigate' || rule.action === 'navigate_msg') && (!rule.toScreen || rule.toScreen === 0 || typeof rule.toScreen === 'undefined');
                
                html += `
                <div style="background: #001100; border: 1px solid #003300; border-radius: 5px; padding: 15px; margin-bottom: 15px;">
                    <div style="margin-bottom: 10px; color: #00ff00; font-weight: bold;">
                        Regra ${index + 1}: ${rule.key} → ${rule.action === 'navigate' ? 'Navegar' : rule.action === 'navigate_msg' ? 'Navegar + Mensagem' : 'Mensagem'}
                    </div>
                    
                    ${needsFrom ? `
                    <div style="margin-bottom: 10px;">
                        <label style="color: #00ff00; display: block; margin-bottom: 5px;">
                            Tela Origem: <span style="color: #ff9800;">"${rule.originalFromScreenName || 'Não especificada'}"</span>
                        </label>
                        <select id="fromScreen_${rule.id}" style="width: 100%; padding: 5px; background: #000; color: #00ff00; border: 1px solid #00ff00;">
                            <option value="">-- Selecione uma tela --</option>
                            ${app.screens.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
                        </select>
                    </div>
                    ` : `
                    <div style="margin-bottom: 10px; color: #00ff00; opacity: 0.7;">
                        ✅ Tela Origem: ${app.screens.find(s => s.id === rule.fromScreen)?.name}
                    </div>
                    `}
                    
                    ${needsTo ? `
                    <div style="margin-bottom: 10px;">
                        <label style="color: #00ff00; display: block; margin-bottom: 5px;">
                            Tela Destino: <span style="color: #ff9800;">"${rule.originalToScreenName || 'Não especificada'}"</span>
                        </label>
                        <select id="toScreen_${rule.id}" style="width: 100%; padding: 5px; background: #000; color: #00ff00; border: 1px solid #00ff00;">
                            <option value="">-- Selecione uma tela --</option>
                            ${app.screens.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
                        </select>
                    </div>
                    ` : rule.action === 'message' ? `
                    <div style="margin-bottom: 10px; color: #00ff00; opacity: 0.7;">
                        💬 Mensagem: ${rule.message}
                    </div>
                    ` : `
                    <div style="margin-bottom: 10px; color: #00ff00; opacity: 0.7;">
                        ✅ Tela Destino: ${app.screens.find(s => s.id === rule.toScreen)?.name}
                    </div>
                    `}
                </div>
                `;
            });
            
            container.innerHTML = html;
        }

        function saveMappings() {
            let updated = 0;
            let stillPending = 0;
            
            console.log('=== SALVANDO ASSOCIAÇÕES ===');
            console.log('app.navigationRules:', app.navigationRules);
            console.log('Regras com needsMapping:', app.navigationRules.filter(r => r.needsMapping));
            
            app.navigationRules.forEach(rule => {
                if (!rule.needsMapping) {
                    console.log(`Regra ${rule.id} não precisa de mapeamento, pulando...`);
                    return;
                }
                
                console.log(`\n📋 Processando regra ${rule.id}:`, JSON.stringify(rule, null, 2));
                
                const fromSelect = document.getElementById(`fromScreen_${rule.id}`);
                const toSelect = document.getElementById(`toScreen_${rule.id}`);
                
                console.log('🔍 Buscando elementos:');
                console.log(`  fromSelect (id: fromScreen_${rule.id}):`, fromSelect);
                console.log(`  toSelect (id: toScreen_${rule.id}):`, toSelect);
                
                if (fromSelect) {
                    console.log(`  fromSelect.value: "${fromSelect.value}" (type: ${typeof fromSelect.value})`);
                }
                if (toSelect) {
                    console.log(`  toSelect.value: "${toSelect.value}" (type: ${typeof toSelect.value})`);
                }
                
                // Atualizar fromScreen se houver select e valor selecionado
                if (fromSelect && fromSelect.value && fromSelect.value !== '') {
                    const newValue = parseFloat(fromSelect.value);
                    console.log(`✏️ Atualizando fromScreen: ${rule.fromScreen} → ${newValue}`);
                    rule.fromScreen = newValue;
                }
                
                // Atualizar toScreen se houver select e valor selecionado
                if (toSelect && toSelect.value && toSelect.value !== '') {
                    const newValue = parseFloat(toSelect.value);
                    console.log(`✏️ Atualizando toScreen: ${rule.toScreen} → ${newValue}`);
                    rule.toScreen = newValue;
                }
                
                console.log(`📊 Após atualização:`, { fromScreen: rule.fromScreen, toScreen: rule.toScreen, action: rule.action });
                
                // Verificar se ainda precisa de mapeamento
                const hasFrom = rule.fromScreen && rule.fromScreen !== 0;
                const hasTo = rule.toScreen && rule.toScreen !== 0;
                const needsTo = rule.action === 'navigate' || rule.action === 'navigate_msg'; // Precisa de toScreen se for navigate ou navigate_msg
                
                console.log(`🔎 Validação: hasFrom=${hasFrom}, hasTo=${hasTo}, needsTo=${needsTo}`);
                
                if (hasFrom && (!needsTo || hasTo)) {
                    console.log('✅ Regra completa! Removendo flags...');
                    delete rule.needsMapping;
                    delete rule.originalFromScreenName;
                    delete rule.originalToScreenName;
                    updated++;
                } else {
                    console.log('⚠️ Regra ainda incompleta');
                    stillPending++;
                }
            });
            
            console.log(`\n=== RESULTADO: ${updated} atualizadas, ${stillPending} pendentes ===`);
            console.log('app.navigationRules após salvar:', app.navigationRules);
            
            renderNavigationRules();
            updatePFKeysLabels();
            closeMappingModal();
            
            if (stillPending > 0) {
                showMessage(`✅ ${updated} regra(s) associada(s). ${stillPending} ainda precisa(m) de associação.`, 'info');
            } else {
                showMessage(`✅ Todas as ${updated} regra(s) associadas com sucesso!`, 'success');
            }
        }

        /* ── IndexedDB: recupera File System handles persistidos pelo index.html ── */
        function openHandleDB() {
            return new Promise(function(resolve, reject) {
                var req = indexedDB.open('cics-studio', 1);
                req.onupgradeneeded = function(e) { e.target.result.createObjectStore('handles'); };
                req.onsuccess = function(e) { resolve(e.target.result); };
                req.onerror = function() { reject(req.error); };
            });
        }
        async function loadHandle(key) {
            try {
                var db = await openHandleDB();
                return await new Promise(function(resolve, reject) {
                    var tx = db.transaction('handles', 'readonly');
                    var req = tx.objectStore('handles').get(key);
                    req.onsuccess = function() { resolve(req.result || null); };
                    req.onerror = function() { resolve(null); };
                });
            } catch(e) { return null; }
        }
        async function storeHandle(key, handle) {
            try {
                var db = await openHandleDB();
                await new Promise(function(resolve, reject) {
                    var tx = db.transaction('handles', 'readwrite');
                    tx.objectStore('handles').put(handle, key);
                    tx.oncomplete = resolve;
                    tx.onerror = function() { reject(tx.error); };
                });
            } catch(e) { /* silencioso */ }
        }

        /* handle reutilizado para salvar na mesma pasta sem perguntar de novo */
        var _saveDirHandle = null;

        async function saveProject(forcePickNew) {
            /* Sincroniza os campos da tela atual de volta para screen.fields */
            if (app.currentScreenIndex >= 0) {
                app.screens[app.currentScreenIndex].fields = app.fields;
            }

            /* Serializa o estado completo */
            const state = {
                screens: app.screens.map(function(s) {
                    return {
                        id: s.id,
                        name: s.name,
                        content: s.content,
                        pfKeys: s.pfKeys || {},
                        bmsSource: s.bmsSource || null,
                        bmsImported: s.bmsImported || false,
                        _bmsHeader: s._bmsHeader || null,
                        fields: s.fields.map(function(f) {
                            return {
                                row: f.row,
                                col: f.col,
                                length: f.length,
                                type: f.type,
                                value: f.value,
                                originalValue: f.originalValue,
                                label: f.label,
                                bmsVariable: f.bmsVariable,
                                bmsAttributes: f.bmsAttributes,
                                validationRules: f.validationRules || [],
                                errorMessage: f.errorMessage || '',
                                isRequired: f.isRequired || false,
                                linkedField: f.linkedField || null
                            };
                        })
                    };
                }),
                navigationRules: app.navigationRules.map(function(r) {
                    return {
                        fromScreen: r.fromScreen,
                        toScreen: r.toScreen,
                        key: r.key,
                        action: r.action,
                        message: r.message || '',
                        originalFromScreenName: r.originalFromScreenName ||
                            (app.screens.find(function(s){ return s.id === r.fromScreen; }) || {}).name || '',
                        originalToScreenName: r.originalToScreenName ||
                            (app.screens.find(function(s){ return s.id === r.toScreen; }) || {}).name || ''
                    };
                }),
                validationKeys: app.validationKeys || [],
                dataMapping: app.dataMapping || {}
            };

            /* Salva no localStorage como cics_editor_state */
            localStorage.setItem('cics_editor_state', JSON.stringify(state));

            /* Monta o objeto .cics completo */
            var projMeta = {};
            try { projMeta = JSON.parse(localStorage.getItem('cics_current_project') || '{}'); } catch(e) {}
            var projName = projMeta.name || 'PROJETO';
            var projData = {
                name: projName,
                version: '3.1',
                created: projMeta.created || new Date().toISOString(),
                savedAt: new Date().toISOString(),
                data: state
            };
            var json = JSON.stringify(projData, null, 2);

            /* ── 1ª tentativa: handle salvo no IndexedDB pelo index.html ── */
            if (!forcePickNew) {
                var projDir = _saveDirHandle || await loadHandle('proj-dir');
                if (projDir) {
                    try {
                        /* Garante permissão de escrita (pode pedir confirmação 1x por sessão) */
                        var perm = await projDir.queryPermission({ mode: 'readwrite' });
                        if (perm !== 'granted') {
                            perm = await projDir.requestPermission({ mode: 'readwrite' });
                        }
                        if (perm === 'granted') {
                            _saveDirHandle = projDir;
                            var fileHandle = await projDir.getFileHandle(projName + '.cics', { create: true });
                            var writable = await fileHandle.createWritable();
                            await writable.write(json);
                            await writable.close();
                            markClean();
                            showMessage('✅ Projeto "' + projName + '" salvo com sucesso!', 'success');
                            return;
                        }
                    } catch(e) { /* cai no próximo método */ }
                }
            }

            /* ── 2ª tentativa: showDirectoryPicker (abre na pasta certa pelo id) ── */
            if ('showDirectoryPicker' in window) {
                try {
                    var baseDir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'simucics-base' });
                    var projDir2 = await baseDir.getDirectoryHandle(projName, { create: true });
                    await storeHandle('proj-dir', projDir2);
                    _saveDirHandle = projDir2;
                    var fileHandle2 = await projDir2.getFileHandle(projName + '.cics', { create: true });
                    var writable2 = await fileHandle2.createWritable();
                    await writable2.write(json);
                    await writable2.close();
                    markClean();
                    showMessage('✅ Projeto "' + projName + '" salvo com sucesso!', 'success');
                    return;
                } catch(e) {
                    if (e.name === 'AbortError') return;
                }
            }

            /* ── Fallback: download do arquivo .cics ── */
            var blob = new Blob([json], { type: 'application/json' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = projName + '.cics';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
            markClean();
            showMessage('✅ Projeto "' + projName + '" salvo!', 'success');
        }

        function downloadFile(content, filename, mimeType) {
            const blob = new Blob([content], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            closeExportModal();
            showMessage(`Arquivo ${filename} baixado com sucesso!`, 'success');
        }

        function exportAsJSON() {
            const data = {
                exportDate: new Date().toISOString(),
                screens: app.screens.map(s => ({ id: s.id, name: s.name })),
                navigationRules: app.navigationRules.map(rule => ({
                    fromScreen: app.screens.find(s => s.id === rule.fromScreen)?.name || rule.originalFromScreenName || 'UNKNOWN',
                    toScreen: rule.action === 'message' ? null : (app.screens.find(s => s.id === rule.toScreen)?.name || rule.originalToScreenName || 'UNKNOWN'),
                    key: rule.key,
                    action: rule.action,
                    message: rule.message || ''
                }))
            };
            
            const json = JSON.stringify(data, null, 2);
            downloadFile(json, 'navigation-rules.json', 'application/json');
        }

        function exportAsCobol() {
            let cobol = `      * NAVIGATION RULES - Generated on ${new Date().toLocaleString()}\n`;
            cobol += `      * Total Rules: ${app.navigationRules.length}\n`;
            cobol += `      *\n`;
            cobol += `       IDENTIFICATION DIVISION.\n`;
            cobol += `       PROGRAM-ID. NAVMENU.\n\n`;
            cobol += `       PROCEDURE DIVISION.\n`;
            cobol += `       PROCESS-NAVIGATION.\n`;
            cobol += `           EVALUATE TRUE\n`;
            
            app.navigationRules.forEach(rule => {
                const fromScreen = app.screens.find(s => s.id === rule.fromScreen)?.name || rule.originalFromScreenName || 'UNKNOWN';
                const toScreen = rule.action === 'message' || rule.action === 'clear' || rule.action === 'clear_msg' ? 'N/A' : (app.screens.find(s => s.id === rule.toScreen)?.name || rule.originalToScreenName || 'UNKNOWN');
                
                cobol += `      * From: ${fromScreen} - Key: ${rule.key}\n`;
                
                if (rule.action === 'navigate') {
                    cobol += `               WHEN CURRENT-MAP = '${fromScreen}'\n`;
                    cobol += `                AND EIBAID = DFHPF${rule.key.replace('PF', '')}\n`;
                    cobol += `                   MOVE '${toScreen}' TO NEXT-MAP\n`;
                    cobol += `                   PERFORM SEND-MAP-${toScreen}\n`;
                } else if (rule.action === 'navigate_msg') {
                    cobol += `               WHEN CURRENT-MAP = '${fromScreen}'\n`;
                    cobol += `                AND EIBAID = DFHPF${rule.key.replace('PF', '')}\n`;
                    cobol += `                   MOVE '${toScreen}' TO NEXT-MAP\n`;
                    if (rule.message) {
                        cobol += `                   MOVE '${rule.message}' TO MSG-FIELD\n`;
                    }
                    cobol += `                   PERFORM SEND-MAP-${toScreen}\n`;
                } else if (rule.action === 'message' && rule.message) {
                    cobol += `               WHEN CURRENT-MAP = '${fromScreen}'\n`;
                    cobol += `                AND EIBAID = DFHPF${rule.key.replace('PF', '')}\n`;
                    cobol += `                   MOVE '${rule.message}' TO MSG-FIELD\n`;
                    cobol += `                   PERFORM DISPLAY-MESSAGE\n`;
                } else if (rule.action === 'clear') {
                    cobol += `               WHEN CURRENT-MAP = '${fromScreen}'\n`;
                    cobol += `                AND EIBAID = DFHPF${rule.key.replace('PF', '')}\n`;
                    cobol += `                   PERFORM CLEAR-ALL-FIELDS\n`;
                    cobol += `                   MOVE 'CAMPOS LIMPOS' TO MSG-FIELD\n`;
                } else if (rule.action === 'clear_msg' && rule.message) {
                    cobol += `               WHEN CURRENT-MAP = '${fromScreen}'\n`;
                    cobol += `                AND EIBAID = DFHPF${rule.key.replace('PF', '')}\n`;
                    cobol += `                   PERFORM CLEAR-ALL-FIELDS\n`;
                    cobol += `                   MOVE '${rule.message}' TO MSG-FIELD\n`;
                } else if (rule.action === 'terminate') {
                    cobol += `               WHEN CURRENT-MAP = '${fromScreen}'\n`;
                    cobol += `                AND EIBAID = DFHPF${rule.key.replace('PF', '')}\n`;
                    cobol += `                   EXEC CICS RETURN END-EXEC\n`;
                }
            });
            
            cobol += `               WHEN OTHER\n`;
            cobol += `                   MOVE 'INVALID KEY' TO MSG-FIELD\n`;
            cobol += `           END-EVALUATE.\n`;
            cobol += `           STOP RUN.\n`;
            
            downloadFile(cobol, 'navigation-rules.cbl', 'text/plain');
        }

        function exportAsTable() {
            let sql = `-- NAVIGATION RULES TABLE\n`;
            sql += `-- Generated on ${new Date().toLocaleString()}\n\n`;
            sql += `CREATE TABLE IF NOT EXISTS NAVIGATION_RULES (\n`;
            sql += `    ID INT PRIMARY KEY AUTO_INCREMENT,\n`;
            sql += `    FROM_SCREEN VARCHAR(50),\n`;
            sql += `    TO_SCREEN VARCHAR(50),\n`;
            sql += `    PF_KEY VARCHAR(10),\n`;
            sql += `    ACTION VARCHAR(20),\n`;
            sql += `    MESSAGE VARCHAR(255)\n`;
            sql += `);\n\n`;
            sql += `DELETE FROM NAVIGATION_RULES;\n\n`;
            
            app.navigationRules.forEach((rule, index) => {
                const fromScreen = app.screens.find(s => s.id === rule.fromScreen)?.name || rule.originalFromScreenName || 'UNKNOWN';
                const toScreen = rule.action === 'message' ? '' : (app.screens.find(s => s.id === rule.toScreen)?.name || rule.originalToScreenName || 'UNKNOWN');
                const message = (rule.message || '').replace(/'/g, "''");
                
                sql += `INSERT INTO NAVIGATION_RULES (FROM_SCREEN, TO_SCREEN, PF_KEY, ACTION, MESSAGE)\n`;
                sql += `VALUES ('${fromScreen}', '${toScreen}', '${rule.key}', '${rule.action}', '${message}');\n`;
            });
            
            downloadFile(sql, 'navigation-rules.sql', 'text/plain');
        }

        function exportAsCSV() {
            // Cabeçalho com todas as colunas detalhadas
            let csv = 'ID,Tela Origem,Tela Destino,Tecla PF,Tipo de Ação,Mensagem,Data Criação,PF TXT Origem,PF TXT Destino\n';
            
            app.navigationRules.forEach((rule, index) => {
                const fromScreen = app.screens.find(s => s.id === rule.fromScreen);
                const toScreen = app.screens.find(s => s.id === rule.toScreen);
                
                const fromScreenName = fromScreen?.name || rule.originalFromScreenName || 'UNKNOWN';
                const toScreenName = (rule.action === 'message' || rule.action === 'clear' || rule.action === 'clear_msg') ? '' : (toScreen?.name || rule.originalToScreenName || 'UNKNOWN');
                const message = (rule.message || '').replace(/"/g, '""');
                const actionText = rule.action === 'navigate' ? 'Navegação' : 
                                  rule.action === 'navigate_msg' ? 'Navegar + Mensagem' :
                                  rule.action === 'message' ? 'Mensagem' :
                                  rule.action === 'clear' ? 'Limpar Campos' :
                                  rule.action === 'clear_msg' ? 'Limpar + Mensagem' : 'Desconhecido';
                
                // Verificar se a tecla está definida no TXT de origem
                const pfKeyInSourceTXT = fromScreen?.pfKeys?.[rule.key] ? 'Sim' : 'Não';
                const pfKeyInDestTXT = toScreen?.pfKeys?.[rule.key] ? 'Sim' : 'Não';
                
                csv += `"${index + 1}",`;
                csv += `"${fromScreenName}",`;
                csv += `"${toScreenName}",`;
                csv += `"${rule.key}",`;
                csv += `"${actionText}",`;
                csv += `"${message}",`;
                csv += `"${new Date().toLocaleDateString('pt-BR')}",`;
                csv += `"${pfKeyInSourceTXT}",`;
                csv += `"${pfKeyInDestTXT}"\n`;
            });
            
            downloadFile(csv, 'navigation-rules.csv', 'text/csv');
        }

        function exportAsExcel() {
            // Criar HTML que o Excel pode abrir e formatar corretamente
            let html = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
  <Title>Regras de Navegação CICS</Title>
  <Author>CICS Terminal Simulator</Author>
  <Created>${new Date().toISOString()}</Created>
 </DocumentProperties>
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#4CAF50" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="Navigate">
   <Interior ss:Color="#E3F2FD" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="Message">
   <Interior ss:Color="#FFF3E0" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="Center">
   <Alignment ss:Horizontal="Center"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Regras de Navegação">
  <Table>
   <Column ss:Width="40"/>
   <Column ss:Width="150"/>
   <Column ss:Width="150"/>
   <Column ss:Width="80"/>
   <Column ss:Width="100"/>
   <Column ss:Width="250"/>
   <Column ss:Width="100"/>
   <Column ss:Width="80"/>
   <Column ss:Width="80"/>
   <Row ss:StyleID="Header">
    <Cell><Data ss:Type="String">ID</Data></Cell>
    <Cell><Data ss:Type="String">Tela Origem</Data></Cell>
    <Cell><Data ss:Type="String">Tela Destino</Data></Cell>
    <Cell><Data ss:Type="String">Tecla PF</Data></Cell>
    <Cell><Data ss:Type="String">Tipo de Ação</Data></Cell>
    <Cell><Data ss:Type="String">Mensagem</Data></Cell>
    <Cell><Data ss:Type="String">Data Criação</Data></Cell>
    <Cell><Data ss:Type="String">PF no TXT Origem</Data></Cell>
    <Cell><Data ss:Type="String">PF no TXT Destino</Data></Cell>
   </Row>`;

            app.navigationRules.forEach((rule, index) => {
                const fromScreen = app.screens.find(s => s.id === rule.fromScreen);
                const toScreen = app.screens.find(s => s.id === rule.toScreen);
                
                const fromScreenName = fromScreen?.name || rule.originalFromScreenName || 'UNKNOWN';
                const toScreenName = (rule.action === 'message' || rule.action === 'clear' || rule.action === 'clear_msg') ? '' : (toScreen?.name || rule.originalToScreenName || 'UNKNOWN');
                const message = (rule.message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const actionText = rule.action === 'navigate' ? 'Navegação' : 
                                  rule.action === 'navigate_msg' ? 'Navegar + Mensagem' :
                                  rule.action === 'message' ? 'Mensagem' :
                                  rule.action === 'clear' ? 'Limpar Campos' :
                                  rule.action === 'clear_msg' ? 'Limpar + Mensagem' : 'Desconhecido';
                const styleID = (rule.action === 'navigate' || rule.action === 'navigate_msg') ? 'Navigate' : 'Message';
                
                const pfKeyInSourceTXT = fromScreen?.pfKeys?.[rule.key] ? 'Sim' : 'Não';
                const pfKeyInDestTXT = toScreen?.pfKeys?.[rule.key] ? 'Sim' : 'Não';
                
                html += `
   <Row ss:StyleID="${styleID}">
    <Cell ss:StyleID="Center"><Data ss:Type="Number">${index + 1}</Data></Cell>
    <Cell><Data ss:Type="String">${fromScreenName}</Data></Cell>
    <Cell><Data ss:Type="String">${toScreenName}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="String">${rule.key}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="String">${actionText}</Data></Cell>
    <Cell><Data ss:Type="String">${message}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="String">${new Date().toLocaleDateString('pt-BR')}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="String">${pfKeyInSourceTXT}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="String">${pfKeyInDestTXT}</Data></Cell>
   </Row>`;
            });

            html += `
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <PageSetup>
    <Header x:Margin="0.3"/>
    <Footer x:Margin="0.3"/>
    <PageMargins x:Bottom="0.75" x:Left="0.7" x:Right="0.7" x:Top="0.75"/>
   </PageSetup>
   <FreezePanes/>
   <FrozenNoSplit/>
   <SplitHorizontal>1</SplitHorizontal>
   <TopRowBottomPane>1</TopRowBottomPane>
   <ActivePane>2</ActivePane>
  </WorksheetOptions>
 </Worksheet>
 <Worksheet ss:Name="Resumo">
  <Table>
   <Column ss:Width="200"/>
   <Column ss:Width="150"/>
   <Row ss:StyleID="Header">
    <Cell><Data ss:Type="String">Informação</Data></Cell>
    <Cell><Data ss:Type="String">Valor</Data></Cell>
   </Row>
   <Row>
    <Cell><Data ss:Type="String">Total de Telas</Data></Cell>
    <Cell><Data ss:Type="Number">${app.screens.length}</Data></Cell>
   </Row>
   <Row>
    <Cell><Data ss:Type="String">Total de Regras</Data></Cell>
    <Cell><Data ss:Type="Number">${app.navigationRules.length}</Data></Cell>
   </Row>
   <Row>
    <Cell><Data ss:Type="String">Data de Exportação</Data></Cell>
    <Cell><Data ss:Type="String">${new Date().toLocaleString('pt-BR')}</Data></Cell>
   </Row>
   <Row>
    <Cell><Data ss:Type="String">Regras de Navegação</Data></Cell>
    <Cell><Data ss:Type="Number">${app.navigationRules.filter(r => r.action === 'navigate').length}</Data></Cell>
   </Row>
   <Row>
    <Cell><Data ss:Type="String">Regras de Mensagem</Data></Cell>
    <Cell><Data ss:Type="Number">${app.navigationRules.filter(r => r.action === 'message').length}</Data></Cell>
   </Row>
  </Table>
 </Worksheet>
</Workbook>`;

            downloadFile(html, 'navigation-rules.xls', 'application/vnd.ms-excel');
        }

        function exportAsXML() {
            let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
            xml += `<NavigationRules exportDate="${new Date().toISOString()}">\n`;
            xml += `  <Screens>\n`;
            
            app.screens.forEach(screen => {
                xml += `    <Screen id="${screen.id}" name="${screen.name}"/>\n`;
            });
            
            xml += `  </Screens>\n`;
            xml += `  <Rules>\n`;
            
            app.navigationRules.forEach(rule => {
                const fromScreen = app.screens.find(s => s.id === rule.fromScreen)?.name || rule.originalFromScreenName || 'UNKNOWN';
                const toScreen = rule.action === 'message' ? '' : (app.screens.find(s => s.id === rule.toScreen)?.name || rule.originalToScreenName || 'UNKNOWN');
                const message = (rule.message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                
                xml += `    <Rule>\n`;
                xml += `      <FromScreen>${fromScreen}</FromScreen>\n`;
                xml += `      <ToScreen>${toScreen}</ToScreen>\n`;
                xml += `      <Key>${rule.key}</Key>\n`;
                xml += `      <Action>${rule.action}</Action>\n`;
                xml += `      <Message>${message}</Message>\n`;
                xml += `    </Rule>\n`;
            });
            
            xml += `  </Rules>\n`;
            xml += `</NavigationRules>`;
            
            downloadFile(xml, 'navigation-rules.xml', 'application/xml');
        }

        function exportAsDocumentation() {
            let html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>Documentação - Regras de Navegação</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        h1 {
            color: #333;
            border-bottom: 3px solid #4CAF50;
            padding-bottom: 10px;
        }
        .info {
            background: #e8f5e9;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 20px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        th {
            background: #4CAF50;
            color: white;
            padding: 12px;
            text-align: left;
        }
        td {
            padding: 10px;
            border-bottom: 1px solid #ddd;
        }
        tr:hover {
            background: #f5f5f5;
        }
        .action-navigate {
            color: #2196F3;
            font-weight: bold;
        }
        .action-message {
            color: #FF9800;
            font-weight: bold;
        }
        .screen-name {
            background: #e3f2fd;
            padding: 3px 8px;
            border-radius: 3px;
            font-family: monospace;
        }
        .key-badge {
            background: #333;
            color: white;
            padding: 3px 8px;
            border-radius: 3px;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <h1>📋 Documentação - Regras de Navegação CICS</h1>
    
    <div class="info">
        <strong>Data de Exportação:</strong> ${new Date().toLocaleString()}<br>
        <strong>Total de Telas:</strong> ${app.screens.length}<br>
        <strong>Total de Regras:</strong> ${app.navigationRules.length}
    </div>

    <h2>📊 Lista de Regras</h2>
    <table>
        <thead>
            <tr>
                <th>#</th>
                <th>Tela Origem</th>
                <th>Tecla</th>
                <th>Ação</th>
                <th>Tela Destino</th>
                <th>Mensagem</th>
            </tr>
        </thead>
        <tbody>`;
            
            app.navigationRules.forEach((rule, index) => {
                const fromScreen = app.screens.find(s => s.id === rule.fromScreen)?.name || rule.originalFromScreenName || 'UNKNOWN';
                const toScreen = (rule.action === 'message' || rule.action === 'clear' || rule.action === 'clear_msg') ? '-' : (app.screens.find(s => s.id === rule.toScreen)?.name || rule.originalToScreenName || 'UNKNOWN');
                const actionClass = (rule.action === 'navigate' || rule.action === 'navigate_msg') ? 'action-navigate' : 'action-message';
                const actionText = rule.action === 'navigate' ? 'NAVEGAR' : 
                                  rule.action === 'navigate_msg' ? 'NAVEGAR + MSG' : 
                                  rule.action === 'message' ? 'MENSAGEM' :
                                  rule.action === 'clear' ? 'LIMPAR' :
                                  rule.action === 'clear_msg' ? 'LIMPAR + MSG' : 'DESCONHECIDO';
                
                html += `
            <tr>
                <td>${index + 1}</td>
                <td><span class="screen-name">${fromScreen}</span></td>
                <td><span class="key-badge">${rule.key}</span></td>
                <td class="${actionClass}">${actionText}</td>
                <td>${rule.action === 'navigate' ? `<span class="screen-name">${toScreen}</span>` : '-'}</td>
                <td>${rule.message || '-'}</td>
            </tr>`;
            });
            
            html += `
        </tbody>
    </table>
</body>
</html>`;
            
            downloadFile(html, 'navigation-rules-doc.html', 'text/html');
        }

        // ========== EXPORTAÇÃO DE VALIDAÇÕES ==========
        
        function exportValidationsAsJSON() {
            const validationConfig = {
                exportDate: new Date().toISOString(),
                validationKeys: app.validationKeys || [],
                screens: app.screens.map(screen => ({
                    id: screen.id,
                    name: screen.name,
                    fields: screen.fields.map(field => ({
                        label: field.label,
                        bmsVariable: field.bmsVariable,
                        type: field.type,
                        length: field.length,
                        row: field.row,
                        col: field.col,
                        isRequired: field.isRequired,
                        validationRules: field.validationRules || []
                    }))
                }))
            };
            
            const json = JSON.stringify(validationConfig, null, 2);
            downloadFile(json, 'validation-config.json', 'application/json');
            closeValidationExportModal();
        }

        function exportValidationsAsCobol() {
            let cobol = `      ******************************************************************\n`;
            cobol += `      * CICS/BMS FIELD VALIDATION PROGRAM\n`;
            cobol += `      * Generated on ${new Date().toLocaleString()}\n`;
            cobol += `      * Total Screens: ${app.screens.length}\n`;
            cobol += `      * Validation Keys: ${(app.validationKeys || []).join(', ')}\n`;
            cobol += `      ******************************************************************\n`;
            cobol += `       IDENTIFICATION DIVISION.\n`;
            cobol += `       PROGRAM-ID. VALIDA.\n\n`;
            cobol += `       DATA DIVISION.\n`;
            cobol += `       WORKING-STORAGE SECTION.\n\n`;
            
            // CICS Communication Area
            cobol += `      * CICS Communication Area\n`;
            cobol += `       01  DFHCOMMAREA.\n`;
            cobol += `           05  COMM-MAP-NAME        PIC X(08).\n`;
            cobol += `           05  COMM-RETURN-CODE     PIC X(02).\n`;
            cobol += `               88  COMM-VALID       VALUE '00'.\n`;
            cobol += `               88  COMM-INVALID     VALUE '99'.\n\n`;
            
            // Working variables
            cobol += `      * Control Variables\n`;
            cobol += `       01  WS-ERROR-FLAG            PIC X(01) VALUE 'N'.\n`;
            cobol += `       01  WS-ERROR-MSG             PIC X(80).\n`;
            cobol += `       01  WS-FIELD-NAME            PIC X(30).\n`;
            cobol += `       01  WS-FIELD-VALUE           PIC X(255).\n`;
            cobol += `       01  WS-COUNTER               PIC 9(03).\n`;
            cobol += `       01  WS-VALID-FLAG            PIC X(01).\n`;
            cobol += `       01  WS-MAP-NAME              PIC X(08).\n\n`;
            
            // DFHAID copy
            cobol += `      * CICS Function Keys\n`;
            cobol += `       COPY DFHAID.\n\n`;
            
            // Generate BMS copybook references for each screen
            cobol += `      * BMS Map Definitions\n`;
            app.screens.forEach(screen => {
                const mapName = screen.name.substring(0, 7).toUpperCase().replace(/[^A-Z0-9]/g, '');
                cobol += `       COPY ${mapName}.\n`;
            });
            cobol += `\n`;
            
            cobol += `       LINKAGE SECTION.\n`;
            cobol += `       01  DFHCOMMAREA              PIC X(10).\n\n`;
            
            cobol += `       PROCEDURE DIVISION.\n\n`;
            
            // Main CICS procedure
            cobol += `      ******************************************************************\n`;
            cobol += `      * MAIN PROCEDURE - CICS ENTRY POINT\n`;
            cobol += `      ******************************************************************\n`;
            cobol += `       MAIN-PROCEDURE.\n`;
            cobol += `           EVALUATE TRUE\n`;
            cobol += `               WHEN EIBCALEN = ZERO\n`;
            cobol += `                   PERFORM FIRST-TIME\n`;
            
            // Generate validation for each configured key
            const validationKeys = app.validationKeys || [];
            validationKeys.forEach(key => {
                if (key === 'ENTER') {
                    cobol += `               WHEN EIBAID = DFHENTER\n`;
                    cobol += `                   PERFORM PROCESS-ENTER\n`;
                } else {
                    const pfNum = key.replace('PF', '');
                    cobol += `               WHEN EIBAID = DFHPF${pfNum}\n`;
                    cobol += `                   PERFORM PROCESS-${key}\n`;
                }
            });
            
            cobol += `               WHEN EIBAID = DFHPF3\n`;
            cobol += `                   EXEC CICS RETURN END-EXEC\n`;
            cobol += `               WHEN OTHER\n`;
            cobol += `                   PERFORM INVALID-KEY\n`;
            cobol += `           END-EVALUATE.\n`;
            cobol += `           EXEC CICS RETURN\n`;
            cobol += `                TRANSID('${app.screens[0]?.name.substring(0,4).toUpperCase() || 'VALD'}')\n`;
            cobol += `                COMMAREA(DFHCOMMAREA)\n`;
            cobol += `                LENGTH(10)\n`;
            cobol += `           END-EXEC.\n\n`;
            
            cobol += `       FIRST-TIME.\n`;
            cobol += `           MOVE LOW-VALUES TO ${app.screens[0]?.name.substring(0,7).replace(/[^A-Z0-9]/g, '') || 'MAP'}O.\n`;
            cobol += `           PERFORM SEND-MAP.\n\n`;
            
            // Generate validation procedures for each screen
            app.screens.forEach(screen => {
                const mapName = screen.name.substring(0, 7).toUpperCase().replace(/[^A-Z0-9]/g, '');
                
                cobol += `      ******************************************************************\n`;
                cobol += `      * VALIDATION FOR SCREEN: ${screen.name}\n`;
                cobol += `      ******************************************************************\n`;
                cobol += `       VALIDATE-${screen.name.replace(/[^A-Z0-9]/g, '-')}.\n`;
                cobol += `           MOVE 'N' TO WS-ERROR-FLAG.\n`;
                cobol += `           EXEC CICS RECEIVE\n`;
                cobol += `                MAP('${mapName}')\n`;
                cobol += `                MAPSET('${mapName}SET')\n`;
                cobol += `                INTO(${mapName}I)\n`;
                cobol += `           END-EXEC.\n\n`;
                
                screen.fields.forEach(field => {
                    if (field.label === 'MENSAGEM') return; // Skip message field
                    
                    const bmsVar = field.bmsVariable || field.label?.toUpperCase().replace(/[^A-Z0-9]/g, '') + 'I';
                    const fieldLabel = field.label || 'Campo';
                    const lenVar = bmsVar.replace('I', 'L'); // Length field
                    
                    cobol += `      * Validating: ${fieldLabel}\n`;
                    
                    // Check if field was entered (length > 0)
                    if (field.isRequired) {
                        cobol += `           IF ${lenVar} = ZERO OR ${bmsVar} = SPACES\n`;
                        cobol += `               MOVE 'Y' TO WS-ERROR-FLAG\n`;
                        cobol += `               MOVE '${fieldLabel} EH OBRIGATORIO' TO MENSAGEMO\n`;
                        cobol += `               MOVE -1 TO ${lenVar}\n`;
                        cobol += `               PERFORM SEND-MAP-DATAONLY\n`;
                        cobol += `               GO TO VALIDATE-END\n`;
                        cobol += `           END-IF.\n`;
                    }
                    
                    // Process each validation rule
                    field.validationRules.forEach(rule => {
                        switch(rule.type) {
                            case 'notZeros':
                                cobol += `      * Validation: Not All Zeros\n`;
                                cobol += `           IF ${bmsVar} = ZEROS\n`;
                                cobol += `               MOVE 'Y' TO WS-ERROR-FLAG\n`;
                                cobol += `               MOVE '${fieldLabel} NAO PODE SER ZEROS' TO MENSAGEMO\n`;
                                cobol += `               MOVE -1 TO ${lenVar}\n`;
                                cobol += `               PERFORM SEND-MAP-DATAONLY\n`;
                                cobol += `               GO TO VALIDATE-END\n`;
                                cobol += `           END-IF.\n`;
                                break;
                                
                            case 'notSpaces':
                                cobol += `      * Validation: Not All Spaces\n`;
                                cobol += `           IF ${bmsVar} = SPACES\n`;
                                cobol += `               MOVE 'Y' TO WS-ERROR-FLAG\n`;
                                cobol += `               MOVE '${fieldLabel} NAO PODE ESTAR EM BRANCO' TO MENSAGEMO\n`;
                                cobol += `               MOVE -1 TO ${lenVar}\n`;
                                cobol += `               PERFORM SEND-MAP-DATAONLY\n`;
                                cobol += `               GO TO VALIDATE-END\n`;
                                cobol += `           END-IF.\n`;
                                break;
                                
                            case 'numeric':
                                cobol += `      * Validation: Numeric Only\n`;
                                cobol += `           IF ${bmsVar} IS NOT NUMERIC\n`;
                                cobol += `               MOVE 'Y' TO WS-ERROR-FLAG\n`;
                                cobol += `               MOVE '${fieldLabel} DEVE SER NUMERICO' TO MENSAGEMO\n`;
                                cobol += `               MOVE -1 TO ${lenVar}\n`;
                                cobol += `               PERFORM SEND-MAP-DATAONLY\n`;
                                cobol += `               GO TO VALIDATE-END\n`;
                                cobol += `           END-IF.\n`;
                                break;
                                
                            case 'alpha':
                                cobol += `      * Validation: Alphabetic Only\n`;
                                cobol += `           IF ${bmsVar} IS NOT ALPHABETIC\n`;
                                cobol += `               MOVE 'Y' TO WS-ERROR-FLAG\n`;
                                cobol += `               MOVE '${fieldLabel} DEVE SER ALFABETICO' TO MENSAGEMO\n`;
                                cobol += `               MOVE -1 TO ${lenVar}\n`;
                                cobol += `               PERFORM SEND-MAP-DATAONLY\n`;
                                cobol += `               GO TO VALIDATE-END\n`;
                                cobol += `           END-IF.\n`;
                                break;
                                
                            case 'minLength':
                                cobol += `      * Validation: Minimum Length ${rule.value}\n`;
                                cobol += `           IF ${lenVar} < ${rule.value}\n`;
                                cobol += `               MOVE 'Y' TO WS-ERROR-FLAG\n`;
                                cobol += `               MOVE '${fieldLabel} MIN ${rule.value} CHARS' TO MENSAGEMO\n`;
                                cobol += `               MOVE -1 TO ${lenVar}\n`;
                                cobol += `               PERFORM SEND-MAP-DATAONLY\n`;
                                cobol += `               GO TO VALIDATE-END\n`;
                                cobol += `           END-IF.\n`;
                                break;
                                
                            case 'maxLength':
                                cobol += `      * Validation: Maximum Length ${rule.value}\n`;
                                cobol += `           IF ${lenVar} > ${rule.value}\n`;
                                cobol += `               MOVE 'Y' TO WS-ERROR-FLAG\n`;
                                cobol += `               MOVE '${fieldLabel} MAX ${rule.value} CHARS' TO MENSAGEMO\n`;
                                cobol += `               MOVE -1 TO ${lenVar}\n`;
                                cobol += `               PERFORM SEND-MAP-DATAONLY\n`;
                                cobol += `               GO TO VALIDATE-END\n`;
                                cobol += `           END-IF.\n`;
                                break;
                                
                            case 'exactLength':
                                cobol += `      * Validation: Exact Length ${rule.value}\n`;
                                cobol += `           IF ${lenVar} NOT = ${rule.value}\n`;
                                cobol += `               MOVE 'Y' TO WS-ERROR-FLAG\n`;
                                cobol += `               MOVE '${fieldLabel} DEVE TER ${rule.value} CHARS' TO MENSAGEMO\n`;
                                cobol += `               MOVE -1 TO ${lenVar}\n`;
                                cobol += `               PERFORM SEND-MAP-DATAONLY\n`;
                                cobol += `               GO TO VALIDATE-END\n`;
                                cobol += `           END-IF.\n`;
                                break;
                                
                            case 'CPF':
                                cobol += `      * Validation: CPF Format\n`;
                                cobol += `           MOVE ${bmsVar} TO WS-FIELD-VALUE\n`;
                                cobol += `           PERFORM VALIDATE-CPF\n`;
                                cobol += `           IF WS-VALID-FLAG = 'N'\n`;
                                cobol += `               MOVE 'Y' TO WS-ERROR-FLAG\n`;
                                cobol += `               MOVE '${fieldLabel} - CPF INVALIDO' TO MENSAGEMO\n`;
                                cobol += `               MOVE -1 TO ${lenVar}\n`;
                                cobol += `               PERFORM SEND-MAP-DATAONLY\n`;
                                cobol += `               GO TO VALIDATE-END\n`;
                                cobol += `           END-IF.\n`;
                                break;
                                
                            case 'email':
                                cobol += `      * Validation: Email Format\n`;
                                cobol += `           MOVE ${bmsVar} TO WS-FIELD-VALUE\n`;
                                cobol += `           PERFORM VALIDATE-EMAIL\n`;
                                cobol += `           IF WS-VALID-FLAG = 'N'\n`;
                                cobol += `               MOVE 'Y' TO WS-ERROR-FLAG\n`;
                                cobol += `               MOVE '${fieldLabel} - EMAIL INVALIDO' TO MENSAGEMO\n`;
                                cobol += `               MOVE -1 TO ${lenVar}\n`;
                                cobol += `               PERFORM SEND-MAP-DATAONLY\n`;
                                cobol += `               GO TO VALIDATE-END\n`;
                                cobol += `           END-IF.\n`;
                                break;
                                
                            case 'date':
                                cobol += `      * Validation: Date Format\n`;
                                cobol += `           MOVE ${bmsVar} TO WS-FIELD-VALUE\n`;
                                cobol += `           PERFORM VALIDATE-DATE\n`;
                                cobol += `           IF WS-VALID-FLAG = 'N'\n`;
                                cobol += `               MOVE 'Y' TO WS-ERROR-FLAG\n`;
                                cobol += `               MOVE '${fieldLabel} - DATA INVALIDA' TO MENSAGEMO\n`;
                                cobol += `               MOVE -1 TO ${lenVar}\n`;
                                cobol += `               PERFORM SEND-MAP-DATAONLY\n`;
                                cobol += `               GO TO VALIDATE-END\n`;
                                cobol += `           END-IF.\n`;
                                break;
                        }
                    });
                    
                    cobol += `\n`;
                });
                
                cobol += `           MOVE 'VALIDACAO OK' TO MENSAGEMO.\n`;
                cobol += `           .\n\n`;
            });
            
            // CICS procedures
            validationKeys.forEach(key => {
                if (key === 'ENTER') {
                    cobol += `       PROCESS-ENTER.\n`;
                } else {
                    cobol += `       PROCESS-${key}.\n`;
                }
                app.screens.forEach(screen => {
                    cobol += `           PERFORM VALIDATE-${screen.name.replace(/[^A-Z0-9]/g, '-')}.\n`;
                    cobol += `           IF WS-ERROR-FLAG = 'N'\n`;
                    cobol += `      * Validation passed - continue processing\n`;
                    cobol += `               PERFORM PROCESS-VALIDATED-DATA\n`;
                    cobol += `           END-IF.\n`;
                });
                cobol += `           .\n\n`;
            });
            
            cobol += `       PROCESS-VALIDATED-DATA.\n`;
            cobol += `      * TODO: Add business logic after validation\n`;
            cobol += `           MOVE 'DADOS PROCESSADOS COM SUCESSO' TO MENSAGEMO.\n`;
            cobol += `           PERFORM SEND-MAP-DATAONLY.\n\n`;
            
            cobol += `       SEND-MAP.\n`;
            cobol += `           EXEC CICS SEND\n`;
            cobol += `                MAP('${app.screens[0]?.name.substring(0,7).replace(/[^A-Z0-9]/g, '') || 'MAP'}')\n`;
            cobol += `                MAPSET('${app.screens[0]?.name.substring(0,7).replace(/[^A-Z0-9]/g, '') || 'MAP'}SET')\n`;
            cobol += `                FROM(${app.screens[0]?.name.substring(0,7).replace(/[^A-Z0-9]/g, '') || 'MAP'}O)\n`;
            cobol += `                ERASE\n`;
            cobol += `           END-EXEC.\n\n`;
            
            cobol += `       SEND-MAP-DATAONLY.\n`;
            cobol += `           EXEC CICS SEND\n`;
            cobol += `                MAP('${app.screens[0]?.name.substring(0,7).replace(/[^A-Z0-9]/g, '') || 'MAP'}')\n`;
            cobol += `                MAPSET('${app.screens[0]?.name.substring(0,7).replace(/[^A-Z0-9]/g, '') || 'MAP'}SET')\n`;
            cobol += `                FROM(${app.screens[0]?.name.substring(0,7).replace(/[^A-Z0-9]/g, '') || 'MAP'}O)\n`;
            cobol += `                DATAONLY\n`;
            cobol += `                CURSOR\n`;
            cobol += `           END-EXEC.\n\n`;
            
            cobol += `       INVALID-KEY.\n`;
            cobol += `           MOVE 'TECLA INVALIDA' TO MENSAGEMO.\n`;
            cobol += `           PERFORM SEND-MAP-DATAONLY.\n\n`;
            
            // Validation helper procedures
            cobol += `       VALIDATE-CPF.\n`;
            cobol += `           MOVE 'Y' TO WS-VALID-FLAG.\n`;
            cobol += `      * TODO: Implement CPF validation algorithm\n`;
            cobol += `      * Check if WS-FIELD-VALUE contains valid CPF\n`;
            cobol += `           .\n\n`;
            
            cobol += `       VALIDATE-EMAIL.\n`;
            cobol += `           MOVE 'Y' TO WS-VALID-FLAG.\n`;
            cobol += `      * TODO: Check for @ symbol and valid email format\n`;
            cobol += `           IF WS-FIELD-VALUE NOT CONTAINS '@'\n`;
            cobol += `               MOVE 'N' TO WS-VALID-FLAG\n`;
            cobol += `           END-IF.\n`;
            cobol += `           .\n\n`;
            
            cobol += `       VALIDATE-DATE.\n`;
            cobol += `           MOVE 'Y' TO WS-VALID-FLAG.\n`;
            cobol += `      * TODO: Implement date validation (DD/MM/YYYY)\n`;
            cobol += `      * Check day (01-31), month (01-12), year format\n`;
            cobol += `           .\n\n`;
            
            cobol += `       VALIDATE-END.\n`;
            cobol += `           EXIT.\n`;
            
            downloadFile(cobol, 'field-validation-cics.cbl', 'text/plain');
            closeValidationExportModal();
        }

        function exportValidationsAsExcel() {
            let html = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
  <Title>Configurações de Validação</Title>
  <Author>CICS Terminal Simulator</Author>
  <Created>${new Date().toISOString()}</Created>
 </DocumentProperties>
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#2196F3" ss:Pattern="Solid"/>
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="Required">
   <Interior ss:Color="#FFEBEE" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="Optional">
   <Interior ss:Color="#E8F5E9" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="Center">
   <Alignment ss:Horizontal="Center"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Validações">
  <Table>
   <Column ss:Width="150"/>
   <Column ss:Width="200"/>
   <Column ss:Width="120"/>
   <Column ss:Width="150"/>
   <Column ss:Width="100"/>
   <Column ss:Width="80"/>
   <Column ss:Width="80"/>
   <Column ss:Width="60"/>
   <Column ss:Width="60"/>
   <Column ss:Width="60"/>
   <Column ss:Width="80"/>
   <Column ss:Width="300"/>
   <Column ss:Width="250"/>
   <Row ss:StyleID="Header">
    <Cell><Data ss:Type="String">Tela</Data></Cell>
    <Cell><Data ss:Type="String">Campo</Data></Cell>
    <Cell><Data ss:Type="String">Variável BMS</Data></Cell>
    <Cell><Data ss:Type="String">Working Storage</Data></Cell>
    <Cell><Data ss:Type="String">PIC</Data></Cell>
    <Cell><Data ss:Type="String">Tipo</Data></Cell>
    <Cell><Data ss:Type="String">Tamanho</Data></Cell>
    <Cell><Data ss:Type="String">Linha</Data></Cell>
    <Cell><Data ss:Type="String">Coluna Início</Data></Cell>
    <Cell><Data ss:Type="String">Coluna Fim</Data></Cell>
    <Cell><Data ss:Type="String">Obrigatório</Data></Cell>
    <Cell><Data ss:Type="String">Validações</Data></Cell>
    <Cell><Data ss:Type="String">Mensagem de Erro</Data></Cell>
   </Row>`;
            
            app.screens.forEach(screen => {
                screen.fields.forEach(field => {
                    const styleID = field.isRequired ? 'Required' : 'Optional';
                    
                    // Variável BMS e Working Storage
                    const bmsVar = field.bmsVariable || field.label?.toUpperCase().replace(/[^A-Z0-9]/g, '') + 'I';
                    const workingVar = 'WS-' + (field.bmsVariable || field.label?.toUpperCase().replace(/[^A-Z0-9]/g, ''));
                    
                    // Tipo para exibição (já vem como 'alpha' ou 'numeric')
                    const tipoExibicao = field.type || 'alpha';
                    
                    // PIC COBOL - numeric = 9, alpha = X
                    const picType = (field.type === 'numeric') ? '9' : 'X';
                    const picClause = `PIC ${picType}(${String(field.length).padStart(3, '0')})`;
                    
                    // Linha começa em 1 (não em 0)
                    const linha = field.row + 1;
                    // Coluna começa em 1 (não em 0)
                    const colunaInicio = field.col + 1;
                    // Coluna fim = coluna início + tamanho - 1
                    const colunaFim = colunaInicio + field.length - 1;
                    // Tamanho calculado = coluna fim - coluna início
                    const tamanho = colunaFim - colunaInicio;
                    
                    // Se o campo tem validações, criar uma linha para cada validação
                    if (field.validationRules && field.validationRules.length > 0) {
                        field.validationRules.forEach((rule, index) => {
                            const validationType = `${rule.type}${rule.value ? `: ${rule.value}` : ''}`;
                            const validationMessage = rule.message || '';
                            
                            html += `
   <Row ss:StyleID="${styleID}">
    <Cell><Data ss:Type="String">${screen.name}</Data></Cell>
    <Cell><Data ss:Type="String">${field.label || ''}</Data></Cell>
    <Cell><Data ss:Type="String">${bmsVar}</Data></Cell>
    <Cell><Data ss:Type="String">${workingVar}</Data></Cell>
    <Cell><Data ss:Type="String">${picClause}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="String">${tipoExibicao}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="Number">${tamanho}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="Number">${linha}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="Number">${colunaInicio}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="Number">${colunaFim}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="String">${field.isRequired ? 'Sim' : 'Não'}</Data></Cell>
    <Cell><Data ss:Type="String">${validationType}</Data></Cell>
    <Cell><Data ss:Type="String">${validationMessage}</Data></Cell>
   </Row>`;
                        });
                    } else {
                        // Campo sem validações - criar uma linha apenas com as informações do campo
                        html += `
   <Row ss:StyleID="${styleID}">
    <Cell><Data ss:Type="String">${screen.name}</Data></Cell>
    <Cell><Data ss:Type="String">${field.label || ''}</Data></Cell>
    <Cell><Data ss:Type="String">${bmsVar}</Data></Cell>
    <Cell><Data ss:Type="String">${workingVar}</Data></Cell>
    <Cell><Data ss:Type="String">${picClause}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="String">${tipoExibicao}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="Number">${tamanho}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="Number">${linha}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="Number">${colunaInicio}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="Number">${colunaFim}</Data></Cell>
    <Cell ss:StyleID="Center"><Data ss:Type="String">${field.isRequired ? 'Sim' : 'Não'}</Data></Cell>
    <Cell><Data ss:Type="String"></Data></Cell>
    <Cell><Data ss:Type="String"></Data></Cell>
   </Row>`;
                    }
                });
            });
            
            html += `
  </Table>
 </Worksheet>
 <Worksheet ss:Name="Teclas de Validação">
  <Table>
   <Column ss:Width="200"/>
   <Row ss:StyleID="Header">
    <Cell><Data ss:Type="String">Teclas que Acionam Validação</Data></Cell>
   </Row>`;
            
            (app.validationKeys || []).forEach(key => {
                html += `
   <Row>
    <Cell><Data ss:Type="String">${key}</Data></Cell>
   </Row>`;
            });
            
            html += `
  </Table>
 </Worksheet>
</Workbook>`;
            
            downloadFile(html, 'validation-config.xls', 'application/vnd.ms-excel');
            closeValidationExportModal();
        }

        function exportValidationsAsCSV() {
            let csv = 'Tela,Campo,Variável BMS,Tipo,Tamanho,Linha,Coluna,Obrigatório,Validações\n';
            
            app.screens.forEach(screen => {
                screen.fields.forEach(field => {
                    const validations = field.validationRules.map(rule => 
                        `${rule.type}${rule.value ? `: ${rule.value}` : ''}`
                    ).join('; ');
                    
                    csv += `"${screen.name}",`;
                    csv += `"${field.label || ''}",`;
                    csv += `"${field.bmsVariable || ''}",`;
                    csv += `"${field.type}",`;
                    csv += `"${field.length}",`;
                    csv += `"${field.row}",`;
                    csv += `"${field.col}",`;
                    csv += `"${field.isRequired ? 'Sim' : 'Não'}",`;
                    csv += `"${validations}"\n`;
                });
            });
            
            csv += `\n\nTeclas de Validação:\n`;
            (app.validationKeys || []).forEach(key => {
                csv += `"${key}"\n`;
            });
            
            downloadFile(csv, 'validation-config.csv', 'text/csv');
            closeValidationExportModal();
        }

        // ─── Funções auxiliares para exportação BMS limpa ───────────────────────────

        // Extrai somente as linhas do bloco DFHMSD (antes do primeiro DFHMDI)
        function _extractDFHMSDPart(bmsText) {
            var lines = bmsText.split('\n');
            var idx = lines.findIndex(function(l) { return /\bDFHMDI\b/i.test(l); });
            if (idx <= 0) return '';
            return lines.slice(0, idx).join('\n') + '\n';
        }

        // Extrai de DFHMDI até antes de DFHMSD TYPE=FINAL
        // Substitui o nome no DFHMDI pelo nome real da tela (screen opcional)
        function _extractDFHMDIPart(bmsText, screen) {
            var lines = bmsText.split('\n');
            var start = lines.findIndex(function(l) { return /\bDFHMDI\b/i.test(l); });
            if (start < 0) return bmsText;
            var end = lines.length;
            for (var i = start; i < lines.length; i++) {
                if (/DFHMSD\s+TYPE\s*=\s*FINAL/i.test(lines[i])) { end = i; break; }
            }
            var block = lines.slice(start, end);
            // Substituir nome no DFHMDI pelo screen.name atual (se fornecido)
            if (screen) {
                var mapName = screen.name.substring(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
                block[0] = block[0].replace(/^(\w+)(\s+DFHMDI\b)/i, mapName.padEnd(6) + '$2');
            }
            return block.join('\n') + '\n';
        }

        // Remove TYPE=FINAL / END do final do texto BMS gerado
        function _stripBMSFinalBlock(bmsText) {
            var lines = bmsText.split('\n');
            var idx = -1;
            for (var i = lines.length - 1; i >= 0; i--) {
                if (/DFHMSD\s+TYPE\s*=\s*FINAL/i.test(lines[i])) { idx = i; break; }
            }
            if (idx < 0) return bmsText;
            // remover também linhas em branco imediatamente antes
            while (idx > 0 && lines[idx - 1].trim() === '') idx--;
            return lines.slice(0, idx).join('\n') + '\n';
        }

        // Remove linhas de comentário geradas pelo sistema (não as do BMS original)
        function _stripBMSSystemComments(bmsText) {
            return bmsText.split('\n').filter(function(line) {
                if (!/^\s*\*/.test(line)) return true;
                if (/^\*\s*={4,}/.test(line))                                      return false;
                if (/^\*\s*(BMS MAP|Generated on|Tela:|Label var)/i.test(line))    return false;
                if (/^\*\s{6}(Campo:|Field:|Validaç|Validation|CAMPO OBRIG|REQUIRED FIELD|Screen:)/i.test(line)) return false;
                return true;
            }).join('\n');
        }

        // Gera bloco DFHMSD sintético (sem comentários) a partir do nome da tela
        function _syntheticDFHMSD(screenName) {
            function fmt(c, cont) { return c.padEnd(71) + (cont ? '-' : ' ') + '\n'; }
            var mapName = screenName.substring(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, '');
            var h = '';
            h += fmt(mapName.padEnd(6) + ' DFHMSD LANG=COBOL,', true);
            h += fmt('              MODE=INOUT,', true);
            h += fmt('              STORAGE=AUTO,', true);
            h += fmt('              TERM=3270,', true);
            h += fmt('              TIOAPFX=YES,', true);
            h += fmt('              TYPE=&SYSPARM');
            h += '\n';
            return h;
        }

        // Gera BMS limpo (sem marcadores do sistema) para uma lista de telas
        function _buildCleanBMSExport(screens) {
            if (!screens || screens.length === 0) return '';
            function fmt(c, cont) { return c.padEnd(71) + (cont ? '-' : ' ') + '\n'; }

            // ── tela única ────────────────────────────────────────────────────
            if (screens.length === 1) {
                var s = screens[0];
                if (s.bmsSource) {
                    // Não editada: usar bmsSource verbatim (inclui DFHMSD original)
                    var bms = s.bmsSource;
                    if (!/DFHMSD\s+TYPE\s*=\s*FINAL/i.test(bms)) {
                        bms += '\n' + fmt('       DFHMSD TYPE=FINAL') + fmt('       END');
                    }
                    return bms;
                }
                // Editada ou não importada: gerar limpo via generateBMSCode
                return _stripBMSSystemComments(generateBMSCode(s));
            }

            // ── múltiplas telas ───────────────────────────────────────────────
            // Estratégia confiável: gerar cada tela via generateBMSCode
            // (os dados dos campos são sempre corretos; _bmsHeader preserva o cabeçalho original)
            // Primeira tela: manter DFHMSD + DFHMDI + campos (sem TYPE=FINAL)
            // Demais telas:  extrair só DFHMDI + campos (sem DFHMSD duplicado, sem TYPE=FINAL)
            // Ao final: emitir um único TYPE=FINAL + END
            var bms = '';
            var dfhmsdEmitted = false;

            screens.forEach(function(screen, i) {
                // Gerar código limpo para esta tela
                var code;
                if (screen.bmsSource && /\bDFHMDI\b/i.test(screen.bmsSource)) {
                    code = _stripBMSFinalBlock(screen.bmsSource);
                } else {
                    code = _stripBMSFinalBlock(_stripBMSSystemComments(generateBMSCode(screen)));
                }

                if (!dfhmsdEmitted) {
                    // Primeira tela: emitir DFHMSD (do código ou sintético) + DFHMDI com nome correto
                    if (/\bDFHMSD\b/i.test(code)) {
                        bms += _extractDFHMSDPart(code);
                    } else {
                        bms += _syntheticDFHMSD(screen.name);
                    }
                    dfhmsdEmitted = true;
                    bms += _extractDFHMDIPart(code, screen);
                } else {
                    // Demais telas: só o bloco DFHMDI com nome correto
                    bms += _extractDFHMDIPart(code, screen);
                }
            });

            // Finalização única
            bms += fmt('       DFHMSD TYPE=FINAL');
            bms += fmt('       END');
            return bms;
        }

        // ─── exportBMSWithOptions ────────────────────────────────────────────────────
        // Chamado pelos botões do modal de exportação BMS
        function exportBMSWithOptions(includeLabels) {
            var exportAll = document.getElementById('bmsExportScopeAll') &&
                            document.getElementById('bmsExportScopeAll').checked;
            var currentScreen = app.screens[app.currentScreenIndex];

            if (!currentScreen) {
                closeBMSOptionsModal();
                showMessage('Selecione uma tela antes de exportar BMS!', 'error');
                return;
            }

            var screensToExport;
            if (exportAll) {
                // Ler quais checkboxes estão marcados
                var checked = [];
                var items = document.getElementById('bmsExportMapItems');
                if (items) {
                    items.querySelectorAll('input[type=checkbox]').forEach(function(c) {
                        if (c.checked) {
                            var idx = parseInt(c.value);
                            if (!isNaN(idx) && app.screens[idx]) checked.push(app.screens[idx]);
                        }
                    });
                }
                if (checked.length === 0) {
                    showMessage('Selecione ao menos um mapa para exportar!', 'error');
                    return;
                }
                screensToExport = checked;
            } else {
                screensToExport = [currentScreen];
            }

            var bmsText = _buildCleanBMSExport(screensToExport);

            // Nome do arquivo
            var fileName;
            if (screensToExport.length > 1) {
                // Tentar extrair nome do mapset do DFHMSD da primeira tela importada
                var fi = screensToExport.find(function(s) { return s.bmsImported && s._bmsHeader; });
                if (fi) {
                    var m = fi._bmsHeader.match(/^(\w+)\s+DFHMSD/im);
                    fileName = (m ? m[1] : screensToExport[0].name.substring(0, 6)) + '.bms';
                } else {
                    fileName = screensToExport[0].name.substring(0, 6) + 'set.bms';
                }
            } else {
                fileName = screensToExport[0].name + '.bms';
            }

            downloadFile(bmsText, fileName, 'text/plain');
            closeBMSOptionsModal();
        }

        // ─────────────────────────────────────────────────────────────────────────────

        function exportValidationsAsBMS(includeLabels = false) {
            // Função auxiliar para formatar linha BMS com 72 colunas e continuação
            function formatBMSLine(content, continuation = false) {
                const line = content.padEnd(71);
                return line + (continuation ? '-' : ' ') + '\n';
            }
            
            // Função para gerar DFHMDF de texto, quebrando em múltiplos DFHMDF se necessário
            function generateTextDFHMDF(text, row, col, includeVar = false, varName = '') {
                let result = '';
                const screenWidth = 80; // Largura da tela CICS
                const maxBMSLine = 71; // Máximo de caracteres antes do hífen/espaço
                let currentCol = col;
                let remainingText = text;
                let isFirstDFHMDF = true;
                
                while (remainingText.length > 0) {
                    // Calcular quanto cabe na tela nesta posição
                    const availableSpace = screenWidth - currentCol;
                    
                    if (availableSpace <= 0) {
                        console.warn(`Texto ultrapassa limite da tela na linha ${row + 1}`);
                        break;
                    }
                    
                    // Montar a linha BMS para calcular o tamanho
                    const prefix = includeVar && isFirstDFHMDF ? varName.padEnd(6) : '       ';
                    
                    // Tentar encaixar o máximo de texto possível
                    let maxTextLength = availableSpace;
                    let foundFit = false;
                    
                    while (maxTextLength > 0 && !foundFit) {
                        const testChunk = remainingText.substring(0, maxTextLength);
                        
                        // Construir linha BMS completa para testar
                        const posLine = `${prefix} DFHMDF POS=(${row + 1},${currentCol + 1}),`;
                        const lengthLine = `              LENGTH=${testChunk.length},`;
                        const attrbLine = `              ATTRB=(ASKIP,NORM),`;
                        const initialLine = `              INITIAL='${testChunk}'`;
                        
                        // Verificar se todas as linhas cabem em 72 colunas
                        if (posLine.length <= maxBMSLine && 
                            lengthLine.length <= maxBMSLine && 
                            attrbLine.length <= maxBMSLine && 
                            initialLine.length <= maxBMSLine) {
                            foundFit = true;
                        } else {
                            // Reduzir o tamanho do texto
                            maxTextLength--;
                        }
                    }
                    
                    if (maxTextLength <= 0) {
                        console.error(`Não foi possível encaixar texto na linha ${row + 1}, col ${currentCol + 1}`);
                        break;
                    }
                    
                    // Pegar o chunk que cabe
                    let chunk = remainingText.substring(0, maxTextLength);
                    
                    // Se não for o último pedaço, tentar quebrar em um espaço
                    if (maxTextLength < remainingText.length) {
                        const lastSpace = chunk.lastIndexOf(' ');
                        if (lastSpace > 0) {
                            chunk = chunk.substring(0, lastSpace);
                        }
                    }
                    
                    // Remover espaços do início (exceto no primeiro DFHMDF)
                    if (!isFirstDFHMDF) {
                        chunk = chunk.trimStart();
                    }
                    
                    const actualLength = chunk.length;
                    
                    // Gerar o DFHMDF para este pedaço
                    const prefix2 = includeVar && isFirstDFHMDF ? varName.padEnd(6) : '       ';
                    result += formatBMSLine(`${prefix2} DFHMDF POS=(${row + 1},${currentCol + 1}),`, true);
                    result += formatBMSLine(`              LENGTH=${actualLength},`, true);
                    result += formatBMSLine(`              ATTRB=(ASKIP,NORM),`, true);
                    result += formatBMSLine(`              INITIAL='${chunk}'`);
                    
                    // Atualizar para próxima iteração
                    remainingText = remainingText.substring(chunk.length).trimStart();
                    currentCol += actualLength;
                    isFirstDFHMDF = false;
                }
                
                return result;
            }
            
            const currentScreen = app.screens[app.currentScreenIndex];
            if (!currentScreen) {
                closeBMSOptionsModal();
                showMessage('Selecione uma tela antes de exportar BMS!', 'error');
                return;
            }

            let bms = '';
            
            [currentScreen].forEach(screen => {
                const mapName = screen.name.substring(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, '');
                const mapSetName = mapName + 'M';
                
                // DFHMSD - Padrão com cada comando em uma linha
                bms += formatBMSLine(`${mapName.padEnd(6)} DFHMSD LANG=COBOL,`, true);
                bms += formatBMSLine(`              MODE=INOUT,`, true);
                bms += formatBMSLine(`              STORAGE=AUTO,`, true);
                bms += formatBMSLine(`              TERM=3270,`, true);
                bms += formatBMSLine(`              TIOAPFX=YES,`, true);
                bms += formatBMSLine(`              TYPE=&&SYSPARM,`, true);
                
                // DFHMDI
                bms += formatBMSLine(`${mapSetName.padEnd(6)} DFHMDI SIZE=(24,80),LINE=1,COLUMN=1`);
                bms += `*      Screen: ${screen.name}\n`;
                bms += `*\n`;
                
                // Capturar todo o texto estático da tela (usando screen.data)
                const staticTexts = [];
                
                for (let row = 0; row < screen.data.length; row++) {
                    let col = 0;
                    let currentText = '';
                    let textStartCol = 0;
                    
                    while (col < screen.data[row].length) {
                        const char = screen.data[row][col];
                        
                        // Verifica se não é um campo editável nesta posição
                        const isField = screen.fields.some(f => 
                            f.row === row && col >= f.col && col < f.col + f.length
                        );
                        
                        if (!isField && char !== ' ') {
                            if (currentText === '') {
                                textStartCol = col;
                            }
                            currentText += char;
                        } else {
                            if (currentText.trim()) {
                                staticTexts.push({ 
                                    row, 
                                    col: textStartCol, 
                                    text: currentText.trim(),
                                    length: currentText.trim().length
                                });
                            }
                            currentText = '';
                        }
                        col++;
                    }
                    
                    // Adicionar texto final da linha se houver
                    if (currentText.trim()) {
                        staticTexts.push({ 
                            row, 
                            col: textStartCol, 
                            text: currentText.trim(),
                            length: currentText.trim().length
                        });
                    }
                }
                
                // Agrupar labels da mesma linha (se não tiver variável)
                const groupedLabels = [];
                if (!includeLabels) {
                    const labelsByRow = {};
                    staticTexts.forEach(label => {
                        if (!labelsByRow[label.row]) {
                            labelsByRow[label.row] = [];
                        }
                        labelsByRow[label.row].push(label);
                    });
                    
                    // Criar labels agrupados por linha, mas separar se houver campo entre eles
                    Object.keys(labelsByRow).forEach(row => {
                        const labelsInRow = labelsByRow[row];
                        labelsInRow.sort((a, b) => a.col - b.col);
                        
                        let currentGroup = [labelsInRow[0]];
                        
                        for (let i = 1; i < labelsInRow.length; i++) {
                            const prevLabel = labelsInRow[i - 1];
                            const currentLabel = labelsInRow[i];
                            
                            // Verificar se há algum campo editável entre este label e o anterior
                            const hasFieldBetween = screen.fields.some(f => 
                                f.row === parseInt(row) && 
                                f.col >= (prevLabel.col + prevLabel.length) && 
                                f.col < currentLabel.col
                            );
                            
                            if (hasFieldBetween) {
                                // Há campo entre eles, finalizar grupo atual e criar novo
                                groupedLabels.push(createGroupedLabel(currentGroup, parseInt(row)));
                                currentGroup = [currentLabel];
                            } else {
                                // Não há campo, adicionar ao grupo atual
                                currentGroup.push(currentLabel);
                            }
                        }
                        
                        // Adicionar o último grupo
                        if (currentGroup.length > 0) {
                            groupedLabels.push(createGroupedLabel(currentGroup, parseInt(row)));
                        }
                    });
                    
                    function createGroupedLabel(labels, row) {
                        const firstCol = labels[0].col;
                        const lastLabel = labels[labels.length - 1];
                        const lastCol = lastLabel.col + lastLabel.length;
                        const totalLength = lastCol - firstCol;
                        
                        // Reconstruir o texto completo com espaços
                        let fullText = '';
                        let currentPos = firstCol;
                        
                        labels.forEach(label => {
                            // Adicionar espaços até a posição do label
                            while (currentPos < label.col) {
                                fullText += ' ';
                                currentPos++;
                            }
                            // Adicionar o texto do label
                            fullText += label.text;
                            currentPos += label.text.length;
                        });
                        
                        return {
                            row: row,
                            col: firstCol,
                            text: fullText,
                            length: totalLength
                        };
                    }
                } else {
                    // Com variável, manter labels separados
                    staticTexts.forEach((label, idx) => {
                        groupedLabels.push({
                            ...label,
                            name: ('LBL' + idx).padEnd(6).substring(0, 6)
                        });
                    });
                }
                
                // Gerar TODOS os elementos da tela na ordem (labels e campos intercalados)
                const allElements = [];
                
                // Adicionar labels
                groupedLabels.forEach((label, idx) => {
                    allElements.push({
                        type: 'label',
                        row: label.row,
                        col: label.col,
                        text: label.text,
                        length: label.length,
                        name: label.name || ('LBL' + idx).padEnd(6).substring(0, 6)
                    });
                });
                
                // Adicionar campos
                screen.fields.forEach((field, idx) => {
                    allElements.push({
                        type: 'field',
                        row: field.row,
                        col: field.col,
                        field: field,
                        name: (field.bmsVariable || field.label || `FLD${idx + 1}`)
                            .toUpperCase()
                            .replace(/[^A-Z0-9]/g, '')
                            .substring(0, 6)
                    });
                });
                
                // Ordenar por linha, depois por coluna
                allElements.sort((a, b) => {
                    if (a.row !== b.row) return a.row - b.row;
                    return a.col - b.col;
                });
                
                // Gerar definições BMS na ordem
                allElements.forEach(element => {
                    if (element.type === 'label') {
                        // Labels - usar função que quebra em múltiplos DFHMDF se necessário
                        bms += generateTextDFHMDF(
                            element.text, 
                            element.row, 
                            element.col, 
                            includeLabels, 
                            includeLabels ? element.name : ''
                        );
                    } else {
                        // Campos editáveis - cada parâmetro em uma linha
                        const field = element.field;
                        const attrb = getBMSAttrString(field);
                        
                        // campo: sem comentário gerado pelo sistema
                        bms += formatBMSLine(`${element.name.padEnd(6)} DFHMDF POS=(${element.row + 1},${element.col + 1}),`, true);
                        bms += formatBMSLine(`              LENGTH=${field.length},`, true);
                        bms += formatBMSLine(`              ATTRB=${attrb}`);
                        
                        // Byte de atributo DEPOIS do campo (auto-skip)
                        const afterCol = element.col + field.length + 1;
                        bms += formatBMSLine(`       DFHMDF POS=(${element.row + 1},${afterCol}),`, true);
                        bms += formatBMSLine(`              LENGTH=0,`, true);
                        bms += formatBMSLine(`              ATTRB=ASKIP`);
                        
                        // Comentários sobre validações
                        // (removidos da saída — não gerar marcações do sistema)
                    }
                });
                
                bms += formatBMSLine(`       DFHMSD TYPE=FINAL`);
                bms += formatBMSLine(`       END`);
                bms += `\n`;
            });
            
            downloadFile(bms, `${currentScreen.name}-map.txt`, 'text/plain');
            closeBMSOptionsModal();
        }

        function exportValidationsAsCopybook() {
            let copybook = `      * ========================================\n`;
            copybook += `      * COPYBOOK - FIELD DEFINITIONS\n`;
            copybook += `      * Generated on ${new Date().toLocaleString()}\n`;
            copybook += `      * Total Screens: ${app.screens.length}\n`;
            copybook += `      * ========================================\n\n`;
            
            app.screens.forEach(screen => {
                copybook += `      * ----------------------------------------\n`;
                copybook += `      * Screen: ${screen.name}\n`;
                copybook += `      * ----------------------------------------\n`;
                
                screen.fields.forEach(field => {
                    const bmsVar = field.bmsVariable || field.label?.toUpperCase().replace(/[^A-Z0-9]/g, '') + 'I';
                    const picType = field.type === 'numeric' ? '9' : 'X';
                    
                    copybook += `      * ${field.label || 'Campo sem label'}\n`;
                    
                    if (field.validationRules.length > 0) {
                        copybook += `      * Validations: ${field.validationRules.map(r => r.type).join(', ')}\n`;
                    }
                    
                    copybook += `       01  ${bmsVar.padEnd(20)} PIC ${picType}(${String(field.length).padStart(3, '0')}).\n`;
                    
                    if (field.isRequired) {
                        copybook += `      * REQUIRED FIELD\n`;
                    }
                    
                    copybook += `\n`;
                });
                
                copybook += `\n`;
            });
            
            copybook += `      * ========================================\n`;
            copybook += `      * VALIDATION KEYS CONFIGURATION\n`;
            copybook += `      * ========================================\n`;
            (app.validationKeys || []).forEach(key => {
                copybook += `      * ${key} triggers validation\n`;
            });
            
            downloadFile(copybook, 'bms-fields.cpy', 'text/plain');
            closeValidationExportModal();
        }

        // Carregar demo completa com múltiplas telas
        function loadExampleScreen() {
            // Tela 1: Menu Principal
            const menuContent = `
        +-----------------------------------------------------------------------+
        |          SISTEMA INTEGRADO DE GESTAO - MENU PRINCIPAL                 |
        +-----------------------------------------------------------------------+
                                                                                
        Selecione uma opcao:                                                    
                                                                                
        1. Cadastro de Clientes                                                 
        2. Consulta de Pedidos                                                  
        3. Relatorios                                                           
        4. Configuracoes                                                        
                                                                                
        Opcao: x                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
                                                                                
        PF3=SAIR  PF12=AJUDA  ENTER=CONFIRMAR                                   
        Usuario: ADMIN001                                       Data: 27/11/2025`;
            
            // Tela 2: Cadastro de Clientes
            const cadastroContent = `
        +-----------------------------------------------------------------------+
        |                    CADASTRO DE CLIENTES                               |
        +-----------------------------------------------------------------------+
                                                                                
        CODIGO: xxxxxx                    STATUS: zzzzzzzzzzzzz                
                                                                                
        NOME COMPLETO: zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz
                                                                                
        CPF/CNPJ: xxxxxxxxxxx             RG: zzzzzzzzzzzzz                    
                                                                                
        ENDERECO: zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz
                                                                                
        CIDADE: zzzzzzzzzzzzzzzzzzzzzz    UF: zz     CEP: xxxxxxxx             
                                                                                
        TELEFONE: xxxxxxxxxxx             EMAIL: zzzzzzzzzzzzzzzzzzzzzzzzzz    
                                                                                
        OBSERVACOES: zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz
                     zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz
                                                                                
        PF3=VOLTAR  PF5=LIMPAR  PF12=AJUDA  ENTER=GRAVAR                       
                                                                                `;
            
            // Tela 3: Consulta de Pedidos
            const consultaContent = `
        +-----------------------------------------------------------------------+
        |                     CONSULTA DE PEDIDOS                               |
        +-----------------------------------------------------------------------+
                                                                                
        CLIENTE: xxxxxx  Nome: zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz    
                                                                                
        PERIODO: xx/xx/xxxx ate xx/xx/xxxx                                      
                                                                                
        +--------+----------+-------------+--------------+-----------------+  
        | Pedido |   Data   |   Valor     |   Status     |     Vendedor    |  
        +--------+----------+-------------+--------------+-----------------+  
        |        |          |             |              |                 |  
        |        |          |             |              |                 |  
        |        |          |             |              |                 |  
        |        |          |             |              |                 |  
        |        |          |             |              |                 |  
        +--------+----------+-------------+--------------+-----------------+  
                                                                                
        Total de Pedidos: 0        Valor Total: R$ 0,00                        
                                                                                
        PF3=VOLTAR  PF7=ANTERIOR  PF8=PROXIMO  PF12=AJUDA  ENTER=DETALHAR      
                                                                                `;
            
            // Criar as telas
            const menuScreen = new Screen('MENU', menuContent);
            const cadastroScreen = new Screen('CAD_CLI', cadastroContent);
            const consultaScreen = new Screen('CONS_PEDS', consultaContent);
            
            // Adicionar as telas
            app.screens.push(menuScreen);
            app.screens.push(cadastroScreen);
            app.screens.push(consultaScreen);
            
            // Criar regras de navegação automáticas
            // Do Menu para Cadastro (opção 1)
            app.navigationRules.push({
                id: Date.now() + Math.random(),
                fromScreen: menuScreen.id,
                toScreen: cadastroScreen.id,
                key: 'ENTER',
                action: 'navigate',
                message: '',
                label: 'CONFIRMAR'
            });
            
            // Do Cadastro para Menu (PF3)
            app.navigationRules.push({
                id: Date.now() + Math.random(),
                fromScreen: cadastroScreen.id,
                toScreen: menuScreen.id,
                key: 'PF3',
                action: 'navigate',
                message: '',
                label: 'VOLTAR'
            });
            
            // Do Cadastro - Limpar (PF5)
            app.navigationRules.push({
                id: Date.now() + Math.random(),
                fromScreen: cadastroScreen.id,
                toScreen: null,
                key: 'PF5',
                action: 'message',
                message: 'Campos limpos com sucesso!',
                label: 'LIMPAR'
            });
            
            // Do Cadastro - Gravar (ENTER)
            app.navigationRules.push({
                id: Date.now() + Math.random(),
                fromScreen: cadastroScreen.id,
                toScreen: null,
                key: 'ENTER',
                action: 'message',
                message: 'Cliente gravado com sucesso! Código: 000123',
                label: 'GRAVAR'
            });
            
            // Do Menu para Consulta (opção 2 + ENTER)
            app.navigationRules.push({
                id: Date.now() + Math.random(),
                fromScreen: menuScreen.id,
                toScreen: consultaScreen.id,
                key: 'PF8',
                action: 'navigate',
                message: '',
                label: 'PRÓXIMO'
            });
            
            // Da Consulta para Menu (PF3)
            app.navigationRules.push({
                id: Date.now() + Math.random(),
                fromScreen: consultaScreen.id,
                toScreen: menuScreen.id,
                key: 'PF3',
                action: 'navigate',
                message: '',
                label: 'VOLTAR'
            });
            
            // Adicionar validações nos campos do cadastro
            const codigoField = cadastroScreen.fields.find(f => f.label === 'CÓDIGO' || f.row === 4);
            if (codigoField) {
                codigoField.isRequired = true;
                codigoField.addValidation('notZeros', null, 'Código não pode ser zeros');
            }
            
            const nomeField = cadastroScreen.fields.find(f => f.label === 'NOME' || (f.row === 6 && f.col > 10));
            if (nomeField) {
                nomeField.isRequired = true;
                nomeField.addValidation('minLength', 3, 'Nome deve ter no mínimo 3 caracteres');
            }
            
            const cpfField = cadastroScreen.fields.find(f => f.label === 'CPF/CNPJ' || (f.row === 8 && f.type === 'numeric'));
            if (cpfField) {
                cpfField.isRequired = true;
                cpfField.addValidation('exactLength', 11, 'CPF deve ter 11 dígitos');
            }
            
            const emailField = cadastroScreen.fields.find(f => f.label === 'EMAIL' || (f.row === 12 && f.col > 40));
            if (emailField) {
                emailField.addValidation('email', null, 'Email inválido');
            }
            
            // Atualizar interface
            updateScreensList();
            renderNavigationRules();
            loadScreen(0);
            
            // Mostrar mensagem de boas-vindas
            showMessage('🎉 Demo carregada! 3 telas com navegação e validações configuradas. Explore e teste!', 'success');
        }

        // Inicializar aplicação
        window.onload = init;
    

        // ═══════════════════════════════════════════════════
        // IDE LAYOUT FUNCTIONS
        // ═══════════════════════════════════════════════════

        function switchSidebarTab(tabName) {
            document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.sidebar-tab-panel').forEach(p => p.classList.remove('active'));
            const tabEl = document.querySelector('.sidebar-tab[data-tab="' + tabName + '"]');
            const panelEl = document.getElementById('tab-' + tabName);
            if (tabEl)   tabEl.classList.add('active');
            if (panelEl) panelEl.classList.add('active');

            if (tabName === 'campos' && app.currentScreenIndex >= 0) {
                renderFieldsList();
            }
        }

        function escapeHtml(text) {
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function generateCobolCode(screen) {
            if (!screen) {
                return [
                    '      * ============================================',
                    '      * Carregue uma tela BMS/TXT para ver o',
                    '      * codigo COBOL/CICS gerado automaticamente.',
                    '      * ============================================'
                ].join('\n');
            }

            /* Nomes derivados da tela */
            var raw      = (screen.name || 'PROGRAMA').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8) || 'PROGRAMA';
            var progName = raw;
            var transId  = raw.substring(0, 4);
            var mapName  = raw.substring(0, 7) + 'M';
            var mapSet   = raw.substring(0, 7) + 'S';
            var fields   = (screen.fields || []).filter(function(f) { return f.row !== 0; });
            var allRules = (app.navigationRules || []).filter(function(r) { return r.fromScreen === screen.id; });
            var keyRules = allRules.filter(function(r) { return r.key !== 'ONLOAD'; });
            var valKeys  = app.validationKeys || ['ENTER'];

            /* Helper: nome variavel WS */
            function wsVar(f, i) {
                if (f.bmsVariable && f.bmsVariable.trim()) {
                    var b = f.bmsVariable.toUpperCase().replace(/[^A-Z0-9]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
                    return ('WS-' + b).substring(0, 30);
                }
                if (f.label && f.label.trim()) {
                    var b2 = f.label.toUpperCase().replace(/[^A-Z0-9]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').substring(0,20);
                    return ('WS-' + b2).substring(0, 30);
                }
                return 'WS-CAMPO-' + String(i + 1).padStart(3, '0');
            }

            /* Helper: nome do paragrafo */
            function pfPar(key) {
                var t = {ENTER:'3000-ENTER',PF1:'3010-PF01',PF2:'3020-PF02',PF3:'3030-PF03',
                         PF4:'3040-PF04',PF5:'3050-PF05',PF6:'3060-PF06',PF7:'3070-PF07',
                         PF8:'3080-PF08',PF9:'3090-PF09',PF10:'3100-PF10',PF11:'3110-PF11',PF12:'3120-PF12'};
                return t[key] || ('3000-' + key);
            }

            /* Helper: constante DFH */
            function dfh(key) { return (key === 'ENTER' ? 'DFHENTER' : 'DFH' + key).padEnd(10); }

            /*
             * Helper: gera o corpo COBOL para uma acao de navegacao.
             * ind = string de espacos para indentacao
             * Tipos de acao:
             *   navigate      -> EXEC CICS XCTL PROGRAM(destino)
             *   navigate_msg  -> MOVE mensagem + EXEC CICS XCTL PROGRAM(destino)
             *   message       -> MOVE mensagem + EXEC CICS SEND MAP DATAONLY
             *   clear         -> MOVE SPACES para cada campo + EXEC CICS SEND MAP DATAONLY
             *   clear_msg     -> MOVE mensagem + MOVE SPACES para cada campo + EXEC CICS SEND MAP DATAONLY
             *   (outros/vazio)-> EXEC CICS RETURN TRANSID
             */
            function genActionBody(rule, ind) {
                var act = rule ? (rule.action || 'navigate') : 'noop';
                var msg = rule ? (rule.message || '').substring(0, 74) : '';
                var tProg = 'DESTINO';
                if (rule && (act === 'navigate' || act === 'navigate_msg')) {
                    var tS = app.screens.find(function(s){ return s.id === rule.toScreen; });
                    tProg = tS ? tS.name.toUpperCase().replace(/[^A-Z0-9]/g,'').substring(0,8) : 'DESTINO';
                }
                var c = '';
                if (act === 'navigate') {
                    c += ind + 'EXEC CICS XCTL\n';
                    c += ind + "    PROGRAM  ('" + tProg + "')\n";
                    c += ind + '    COMMAREA (WS-COMM-AREA)\n';
                    c += ind + 'END-EXEC\n';
                } else if (act === 'navigate_msg') {
                    if (msg) {
                        c += ind + "MOVE '" + msg + "'\n";
                        c += ind + '    TO WS-MENSAGEM\n';
                    }
                    c += ind + 'EXEC CICS XCTL\n';
                    c += ind + "    PROGRAM  ('" + tProg + "')\n";
                    c += ind + '    COMMAREA (WS-COMM-AREA)\n';
                    c += ind + 'END-EXEC\n';
                } else if (act === 'message') {
                    var safeMsg = msg || 'Operacao concluida';
                    c += ind + "MOVE '" + safeMsg + "'\n";
                    c += ind + '    TO WS-MENSAGEM\n';
                    c += ind + 'EXEC CICS SEND\n';
                    c += ind + "    MAP    ('" + mapName + "')\n";
                    c += ind + "    MAPSET ('" + mapSet + "')\n";
                    c += ind + '    FROM   (WS-MENSAGEM) DATAONLY\n';
                    c += ind + 'END-EXEC\n';
                } else if (act === 'clear') {
                    fields.forEach(function(f, i) {
                        var vn  = wsVar(f, i);
                        var blk = f.type === 'numeric' ? 'ZERO' : 'SPACES';
                        c += ind + 'MOVE ' + blk + ' TO ' + vn + '\n';
                    });
                    c += ind + 'EXEC CICS SEND\n';
                    c += ind + "    MAP    ('" + mapName + "')\n";
                    c += ind + "    MAPSET ('" + mapSet + "')\n";
                    c += ind + '    ERASE\n';
                    c += ind + 'END-EXEC\n';
                } else if (act === 'clear_msg') {
                    var safeMsg2 = msg || 'Campos limpos';
                    c += ind + "MOVE '" + safeMsg2 + "'\n";
                    c += ind + '    TO WS-MENSAGEM\n';
                    fields.forEach(function(f, i) {
                        var vn  = wsVar(f, i);
                        var blk = f.type === 'numeric' ? 'ZERO' : 'SPACES';
                        c += ind + 'MOVE ' + blk + ' TO ' + vn + '\n';
                    });
                    c += ind + 'EXEC CICS SEND\n';
                    c += ind + "    MAP    ('" + mapName + "')\n";
                    c += ind + "    MAPSET ('" + mapSet + "')\n";
                    c += ind + '    FROM   (WS-MENSAGEM) DATAONLY\n';
                    c += ind + 'END-EXEC\n';
                } else {
                    /* padrao: retornar na mesma transacao */
                    c += ind + 'EXEC CICS RETURN\n';
                    c += ind + "    TRANSID  ('" + transId + "')\n";
                    c += ind + '    COMMAREA (WS-COMM-AREA)\n';
                    c += ind + '    LENGTH   (1000)\n';
                    c += ind + 'END-EXEC\n';
                }
                return c;
            }

            var L = '';

            L += '      * ===================================================\n';
            L += '      * PROGRAMA : ' + progName + '\n';
            L += '      * TELA     : ' + screen.name + '\n';
            L += '      * MAPNAME  : ' + mapName + '    MAPSET : ' + mapSet + '\n';
            L += '      * TRANSID  : ' + transId + '      CAMPOS : ' + fields.length + '    REGRAS : ' + keyRules.length + '\n';
            L += '      * ===================================================\n';

            L += '       IDENTIFICATION DIVISION.\n';
            L += '       PROGRAM-ID. ' + progName + '.\n';
            L += '       AUTHOR. CICS-COBOL-EDITOR.\n';
            L += '      *\n';
            L += '       ENVIRONMENT DIVISION.\n';
            L += '      *\n';
            L += '       DATA DIVISION.\n';
            L += '       WORKING-STORAGE SECTION.\n';
            L += '      *--- Copybooks CICS ---\n';
            L += '       COPY DFHAID.\n';
            L += '       COPY DFHBMSCA.\n';
            L += '      *--- Area de Comunicacao ---\n';
            L += '       01  WS-COMM-AREA.\n';
            L += '           05  WS-CA-TELA           PIC X(8)    VALUE SPACES.\n';
            L += '           05  WS-CA-DADOS          PIC X(992)  VALUE SPACES.\n';
            L += '      *--- Variaveis de Controle ---\n';
            L += '       01  WS-CTRL.\n';
            L += "           05  WS-ERR-FLAG          PIC X(1)    VALUE 'N'.\n";
            L += '           05  WS-RETURN-CODE       PIC 9(4)    VALUE ZERO.\n';
            L += '           05  WS-EIBRESP           PIC 9(8)    VALUE ZERO.\n';
            L += '       01  WS-MENSAGEM              PIC X(80)   VALUE SPACES.\n';

            if (fields.length > 0) {
                L += '      *--- Campos da Tela (' + fields.length + ' campo(s)) ---\n';
                fields.forEach(function(f, i) {
                    var vn  = wsVar(f, i);
                    var pic = f.type === 'numeric' ? '9' : 'X';
                    var len = String(Math.max(1, f.length || 1));
                    var obs = f.isRequired ? '   *OBRIGATORIO' : '';
                    L += '       01  ' + vn.padEnd(24) + ' PIC ' + pic + '(' + len + ').' + obs + '\n';
                });
            }

            L += '      *\n';
            L += '       LINKAGE SECTION.\n';
            L += '       01  DFHCOMMAREA              PIC X(1000).\n';
            L += '      *\n';

            L += '       PROCEDURE DIVISION.\n';
            L += '      *\n';

            /* 0000-MAIN */
            L += '       0000-MAIN.\n';
            L += '           EVALUATE TRUE\n';
            L += '               WHEN EIBCALEN = ZERO\n';
            L += '                   PERFORM 1000-INICIALIZAR\n';
            L += '               WHEN OTHER\n';
            L += '                   PERFORM 2000-PROCESSAR\n';
            L += '           END-EVALUATE\n';
            L += '           EXEC CICS RETURN\n';
            L += "               TRANSID   ('" + transId + "')\n";
            L += '               COMMAREA  (WS-COMM-AREA)\n';
            L += '               LENGTH    (1000)\n';
            L += '           END-EXEC.\n';
            L += '      *\n';

            /* 1000-INICIALIZAR */
            L += '       1000-INICIALIZAR.\n';
            L += '           MOVE SPACES TO WS-COMM-AREA\n';
            L += '           EXEC CICS SEND\n';
            L += "               MAP    ('" + mapName + "')\n";
            L += "               MAPSET ('" + mapSet + "')\n";
            L += '               ERASE\n';
            L += '           END-EXEC.\n';
            L += '      *\n';

            /* 2000-PROCESSAR */
            L += '       2000-PROCESSAR.\n';
            L += '           EXEC CICS RECEIVE\n';
            L += "               MAP    ('" + mapName + "')\n";
            L += "               MAPSET ('" + mapSet + "')\n";
            L += '           END-EXEC\n';
            L += '           MOVE EIBRESP TO WS-EIBRESP\n';

            var hasPFRules = ['PF1','PF2','PF3','PF4','PF5','PF6','PF7','PF8','PF9','PF10','PF11','PF12']
                .filter(function(k) { return keyRules.some(function(r){ return r.key === k; }); });

            L += '           EVALUATE TRUE\n';
            L += '               WHEN EIBAID = ' + dfh('ENTER') + '\n';
            L += '                   PERFORM 3000-ENTER\n';
            hasPFRules.forEach(function(k) {
                L += '               WHEN EIBAID = ' + dfh(k) + '\n';
                L += '                   PERFORM ' + pfPar(k) + '\n';
            });
            L += '               WHEN OTHER\n';
            L += '                   PERFORM 9900-INVALIDO\n';
            L += '           END-EVALUATE.\n';
            L += '      *\n';

            /* ── 3000-ENTER ─────────────────────────────────── */
            var enterRule = keyRules.find(function(r){ return r.key === 'ENTER'; });
            var enterAct  = enterRule ? (enterRule.action || 'navigate') : 'noop';
            var enterVal  = valKeys.indexOf('ENTER') >= 0 || fields.some(function(f){ return f.isRequired; });

            L += '       3000-ENTER.\n';
            if (enterVal) {
                L += '           PERFORM 4000-VALIDAR\n';
                L += "           IF WS-ERR-FLAG = 'N'\n";
                /* gerar acao indentada para o bloco IF */
                var enterBody = genActionBody(enterRule, '               ');
                /* converter ultimas quebras de linha em terminacoes corretas */
                L += enterBody.replace(/\n$/, '\n');
                L += '           ELSE\n';
                L += '               EXEC CICS SEND\n';
                L += "                   MAP    ('" + mapName + "')\n";
                L += "                   MAPSET ('" + mapSet + "')\n";
                L += '                   FROM   (WS-MENSAGEM) DATAONLY\n';
                L += '               END-EXEC\n';
                L += '           END-IF.\n';
            } else {
                var enterBodyNoVal = genActionBody(enterRule, '           ');
                /* trocar ultimo END-EXEC\n por END-EXEC.\n */
                enterBodyNoVal = enterBodyNoVal.replace(/END-EXEC\n$/, 'END-EXEC.\n');
                L += enterBodyNoVal;
            }
            L += '      *\n';

            /* ── Paragrafos PF1-PF12 ────────────────────────── */
            ['PF1','PF2','PF3','PF4','PF5','PF6','PF7','PF8','PF9','PF10','PF11','PF12'].forEach(function(k) {
                var rule = keyRules.find(function(r){ return r.key === k; });
                if (!rule) return;
                var doV  = valKeys.indexOf(k) >= 0;
                L += '       ' + pfPar(k) + '.\n';
                if (doV) {
                    L += '           PERFORM 4000-VALIDAR\n';
                    L += "           IF WS-ERR-FLAG = 'N'\n";
                    var pfBody = genActionBody(rule, '               ');
                    L += pfBody.replace(/\n$/, '\n');
                    L += '           END-IF.\n';
                } else {
                    var pfBodyNoVal = genActionBody(rule, '           ');
                    pfBodyNoVal = pfBodyNoVal.replace(/END-EXEC\n$/, 'END-EXEC.\n');
                    L += pfBodyNoVal;
                }
                L += '      *\n';
            });

            /* ── 4000-VALIDAR ───────────────────────────────── */
            var reqFields  = fields.filter(function(f){ return f.isRequired; });
            var ruleFields = fields.filter(function(f){ return f.validationRules && f.validationRules.length > 0; });
            L += '       4000-VALIDAR.\n';
            L += "           MOVE 'N' TO WS-ERR-FLAG\n";
            if (reqFields.length === 0 && ruleFields.length === 0) {
                L += '           EXIT.\n';
            } else {
                reqFields.forEach(function(f) {
                    var vn  = wsVar(f, fields.indexOf(f));
                    var blk = f.type === 'numeric' ? 'ZERO' : 'SPACES';
                    var lb  = (f.label || vn).substring(0, 30);
                    L += '           IF ' + vn + ' = ' + blk + '\n';
                    L += "               MOVE 'Campo " + lb + " obrigatorio'\n";
                    L += '                   TO WS-MENSAGEM\n';
                    L += "               MOVE 'S' TO WS-ERR-FLAG\n";
                    L += '           END-IF\n';
                });
                ruleFields.forEach(function(f) {
                    var vn2 = wsVar(f, fields.indexOf(f));
                    f.validationRules.forEach(function(vr) {
                        var em = (vr.message || 'Erro de validacao').substring(0, 70);
                        if (vr.type === 'required') {
                            var blk2 = f.type === 'numeric' ? 'ZERO' : 'SPACES';
                            L += '           IF ' + vn2 + ' = ' + blk2 + '\n';
                            L += "               MOVE '" + em + "' TO WS-MENSAGEM\n";
                            L += "               MOVE 'S' TO WS-ERR-FLAG\n";
                            L += '           END-IF\n';
                        } else if (vr.type === 'minLength') {
                            L += '      *     Min ' + vr.params + ' chars: ' + vn2 + '\n';
                            L += '           IF FUNCTION LENGTH(FUNCTION TRIM(' + vn2 + ')) < ' + vr.params + '\n';
                            L += "               MOVE '" + em + "' TO WS-MENSAGEM\n";
                            L += "               MOVE 'S' TO WS-ERR-FLAG\n";
                            L += '           END-IF\n';
                        } else if (vr.type === 'maxLength') {
                            L += '      *     Max ' + vr.params + ' chars: ' + vn2 + '\n';
                            L += '           IF FUNCTION LENGTH(FUNCTION TRIM(' + vn2 + ')) > ' + vr.params + '\n';
                            L += "               MOVE '" + em + "' TO WS-MENSAGEM\n";
                            L += "               MOVE 'S' TO WS-ERR-FLAG\n";
                            L += '           END-IF\n';
                        } else if (vr.type === 'exactLength') {
                            L += '      *     Exato ' + vr.params + ' chars: ' + vn2 + '\n';
                            L += '           IF FUNCTION LENGTH(FUNCTION TRIM(' + vn2 + ')) NOT = ' + vr.params + '\n';
                            L += "               MOVE '" + em + "' TO WS-MENSAGEM\n";
                            L += "               MOVE 'S' TO WS-ERR-FLAG\n";
                            L += '           END-IF\n';
                        } else if (vr.type === 'numeric') {
                            L += '      *     Numerico: ' + vn2 + '\n';
                            L += '           EVALUATE ' + vn2 + '\n';
                            L += '               WHEN NOT NUMERIC\n';
                            L += "                   MOVE '" + em + "' TO WS-MENSAGEM\n";
                            L += "                   MOVE 'S' TO WS-ERR-FLAG\n";
                            L += '           END-EVALUATE\n';
                        } else if (vr.type === 'noSpaces') {
                            L += '           IF ' + vn2 + ' = SPACES\n';
                            L += "               MOVE '" + em + "' TO WS-MENSAGEM\n";
                            L += "               MOVE 'S' TO WS-ERR-FLAG\n";
                            L += '           END-IF\n';
                        } else if (vr.type === 'notZeros') {
                            L += '           IF ' + vn2 + ' = ZERO\n';
                            L += "               MOVE '" + em + "' TO WS-MENSAGEM\n";
                            L += "               MOVE 'S' TO WS-ERR-FLAG\n";
                            L += '           END-IF\n';
                        } else {
                            L += '      *     Regra ' + vr.type + ': ' + vn2 + '\n';
                        }
                    });
                });
                L += '           EXIT.\n';
            }
            L += '      *\n';

            /* ── 9000-RETORNAR ──────────────────────────────── */
            L += '       9000-RETORNAR.\n';
            L += '           EXEC CICS RETURN\n';
            L += '           END-EXEC.\n';
            L += '      *\n';

            /* ── 9900-INVALIDO ──────────────────────────────── */
            L += '       9900-INVALIDO.\n';
            L += "           MOVE 'TECLA NAO DEFINIDA'\n";
            L += '               TO WS-MENSAGEM\n';
            L += '           EXEC CICS SEND\n';
            L += "               MAP    ('" + mapName + "')\n";
            L += "               MAPSET ('" + mapSet + "')\n";
            L += '               FROM   (WS-MENSAGEM) DATAONLY\n';
            L += '           END-EXEC.\n';
            return L;
        }

        function _wrapCodeLines(html) {
            return html.split('\n').map(function(line) {
                return '<span class="code-line">' + line + '</span>';
            }).join('');
        }

        function syntaxHighlightCobol(code) {
            // Divisões e seções principais que recebem separador visual estilo IDE
            var MAJOR_HEADERS = [
                'IDENTIFICATION DIVISION',
                'ENVIRONMENT DIVISION',
                'DATA DIVISION',
                'WORKING-STORAGE SECTION',
                'LINKAGE SECTION',
                'FILE SECTION',
                'PROCEDURE DIVISION'
            ];
            return code.split('\n').map(function(line) {
                var esc = escapeHtml(line);
                var upper = line.trim().toUpperCase();
                if (/^      \*/.test(line)) return '<span class="cc-comment">' + esc + '</span>';
                // Separador visual para divisões/seções principais
                var isDivHeader = MAJOR_HEADERS.some(function(d) { return upper.startsWith(d); });
                if (isDivHeader) return '<span class="cc-division-header">' + esc + '</span>';
                if (/\b(DIVISION|SECTION)\b/.test(line)) return '<span class="cc-division">' + esc + '</span>';
                if (/\bEXEC\s+CICS\b|\bEND-EXEC\b/.test(line)) return '<span class="cc-keyword">' + esc + '</span>';
                if (/^\s+COPY\b/.test(line)) return '<span class="cc-keyword">' + esc + '</span>';
                if (/^       [A-Z0-9][A-Z0-9\-]+\.$/.test(line)) return '<span class="cc-division">' + esc + '</span>';
                if (/^\s+(PROGRAM-ID|AUTHOR)\b/.test(line)) return '<span class="cc-keyword">' + esc + '</span>';
                var m = line.match(/^(\s+)(0[15]\s+)(\S+)(\s+PIC\s+[9X]\(\d+\)\.?)(.*)/);
                if (m) return escapeHtml(m[1]) +
                    '<span class="cc-level">'   + escapeHtml(m[2]) + '</span>' +
                    '<span class="cc-field">'   + escapeHtml(m[3]) + '</span>' +
                    '<span class="cc-keyword">' + escapeHtml(m[4]) + '</span>' +
                    '<span class="cc-rest">'    + escapeHtml(m[5]) + '</span>';
                var mg = line.match(/^(\s+)(0[15]\s+)([A-Z][A-Z0-9\-]+\.)(.*)$/);
                if (mg) return escapeHtml(mg[1]) +
                    '<span class="cc-level">' + escapeHtml(mg[2]) + '</span>' +
                    '<span class="cc-field">' + escapeHtml(mg[3]) + '</span>' +
                    escapeHtml(mg[4]);
                if (/^\s+(EVALUATE|END-EVALUATE)\b/.test(line)) return '<span class="cc-division">' + esc + '</span>';
                if (/^\s+WHEN\b/.test(line)) return '<span class="cc-keyword">' + esc + '</span>';
                if (/^\s+(IF|ELSE|END-IF)\b/.test(line)) return '<span class="cc-keyword">' + esc + '</span>';
                if (/^\s+(PERFORM|MOVE|CONTINUE|EXIT|STOP\s+RUN)\b/.test(line)) return '<span class="cc-keyword">' + esc + '</span>';
                /* strings literais dentro das linhas de instrução */
                if (/'\w[^']*'/.test(line) && !/^      \*/.test(line)) {
                    var colored = esc.replace(/'([^']*)'/g, '<span class="cc-string">\'$1\'</span>');
                    return colored;
                }
                if (/\bDFH(ENTER|PF\d+|CLEAR)\b/.test(line)) return '<span class="cc-number">' + esc + '</span>';
                if (/\b(TRANSID|PROGRAM|MAPSET|COMMAREA|EIBAID|EIBCALEN|EIBRESP|ERASE|DATAONLY|XCTL|RETURN|SEND|RECEIVE)\b/.test(line))
                    return '<span class="cc-field">' + esc + '</span>';
                return esc;
            }).join('\n');
        }

        function togglePropSection(id) {
            var body  = document.getElementById('propBody'  + id.charAt(0).toUpperCase() + id.slice(1));
            var arrow = document.getElementById('propArrow' + id.charAt(0).toUpperCase() + id.slice(1));
            if (!body) return;
            var open = body.style.display !== 'none';
            body.style.display  = open ? 'none' : 'block';
            if (arrow) arrow.textContent = open ? '▶' : '▼';
        }

        function togglePropValKey(key) {
            if (!app.validationKeys) app.validationKeys = ['ENTER'];
            var idx = app.validationKeys.indexOf(key);
            if (idx >= 0) {
                app.validationKeys.splice(idx, 1);
            } else {
                app.validationKeys.push(key);
            }
            /* Sincronizar checkboxes do modal Campos */
            var cb = document.querySelector('.validation-global-config input[value="' + key + '"]');
            if (cb) cb.checked = app.validationKeys.indexOf(key) >= 0;
            /* Re-renderizar painel (preserva estado aberto da seção) */
            var bodyEl  = document.getElementById('propBodyValkeys');
            var arrowEl = document.getElementById('propArrowValkeys');
            var wasOpen = bodyEl ? bodyEl.style.display !== 'none' : false;
            updateCodePanel(true);
            /* Restaurar estado aberto após re-render */
            var bodyEl2  = document.getElementById('propBodyValkeys');
            var arrowEl2 = document.getElementById('propArrowValkeys');
            if (bodyEl2 && wasOpen) {
                bodyEl2.style.display = 'block';
                if (arrowEl2) arrowEl2.textContent = '▼';
            }
        }

        function switchMainTab(mainTab) {
            app.activeMainTab = mainTab;
            var tabProp     = document.getElementById('tabProp');
            var tabViewCode = document.getElementById('tabViewCode');
            var subTabs     = document.getElementById('viewCodeSubTabs');
            if (tabProp)     tabProp.className    = 'code-tab ' + (mainTab === 'propriedade' ? 'code-tab-active' : 'code-tab-inactive');
            if (tabViewCode) tabViewCode.className = 'code-tab ' + (mainTab === 'viewcode'    ? 'code-tab-active' : 'code-tab-inactive');
            if (subTabs)     subTabs.style.display = mainTab === 'viewcode' ? '' : 'none';
            updateCodePanel();
        }

        function switchCodeTab(tab) {
            app.activeCodeTab = tab;
            var tabCics = document.getElementById('tabCics');
            var tabBms  = document.getElementById('tabBms');
            if (tabCics) tabCics.className = 'code-tab ' + (tab === 'cics' ? 'code-tab-active' : 'code-tab-inactive');
            if (tabBms)  tabBms.className  = 'code-tab ' + (tab === 'bms'  ? 'code-tab-active' : 'code-tab-inactive');
            updateCodePanel();
        }

        // Extrai o bloco DFHMSD + DFHMDI do source BMS original (salvo em screen._bmsHeader)
        // ou reconstrói a partir dos dados disponíveis.
        // O nome do DFHMDI é sempre substituído pelo screen.name atual (evita nomes desatualizados).
        function _extractBMSHeader(screen) {
            function fmt(content, cont) { return content.padEnd(71) + (cont ? '-' : ' ') + '\n'; }
            var mapName = screen.name.substring(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');

            if (screen._bmsHeader) {
                // Substituir o nome no DFHMDI pelo nome atual da tela
                var hdr = screen._bmsHeader;
                hdr = hdr.replace(/^(\w+)(\s+DFHMDI\b)/im, mapName.padEnd(6) + '$2');
                return hdr + '\n';
            }
            // Caso contrário, gerar header neutro
            var mapSetName = mapName + 'M';
            var h = '';
            h += fmt(mapName.padEnd(6) + ' DFHMSD LANG=COBOL,', true);
            h += fmt('              MODE=INOUT,', true);
            h += fmt('              STORAGE=AUTO,', true);
            h += fmt('              TERM=3270,', true);
            h += fmt('              TIOAPFX=YES,', true);
            h += fmt('              TYPE=&SYSPARM');
            h += '\n';
            h += fmt(mapSetName.padEnd(6) + ' DFHMDI SIZE=(24,80),LINE=1,COLUMN=1');
            h += '*\n';
            return h;
        }

        function generateBMSCode(screen) {
            if (!screen) {
                return [
                    '* ========================================',
                    '* BMS MAP - Nenhuma tela selecionada',
                    '* ========================================',
                    '* Carregue uma tela para visualizar o BMS.'
                ].join('\n');
            }

            function formatBMSLine(content, continuation) {
                return content.padEnd(71) + (continuation ? '-' : ' ') + '\n';
            }

            function generateTextDFHMDF(text, row, col) {
                var result = '';
                var screenWidth = 80;
                var maxBMSLine = 71;
                var currentCol = col;
                var remainingText = text;

                while (remainingText.length > 0) {
                    var availableSpace = screenWidth - currentCol;
                    if (availableSpace <= 0) break;

                    var maxTextLength = Math.min(availableSpace, remainingText.length);
                    var foundFit = false;

                    while (maxTextLength > 0 && !foundFit) {
                        var testChunk = remainingText.substring(0, maxTextLength);
                        var posLine    = '       DFHMDF POS=(' + (row + 1) + ',' + (currentCol + 1) + '),';
                        var lengthLine = '              LENGTH=' + testChunk.length + ',';
                        var attrbLine  = '              ATTRB=(ASKIP,NORM),';
                        var initLine   = "              INITIAL='" + testChunk + "'";
                        if (posLine.length <= maxBMSLine && lengthLine.length <= maxBMSLine &&
                            attrbLine.length <= maxBMSLine && initLine.length <= maxBMSLine) {
                            foundFit = true;
                        } else {
                            maxTextLength--;
                        }
                    }
                    if (maxTextLength <= 0) break;

                    var chunk = remainingText.substring(0, maxTextLength);
                    if (maxTextLength < remainingText.length) {
                        var lastSpace = chunk.lastIndexOf(' ');
                        if (lastSpace > 0) chunk = chunk.substring(0, lastSpace);
                    }
                    chunk = chunk.replace(/\s+$/, '');
                    var actualLength = chunk.length;

                    var safeChunk = chunk
                        .replace(/[═─━╌╍┄┅┈┉]/g, '-')
                        .replace(/[║│┃╎╏┆┇┊┋]/g, '|')
                        .replace(/[╔╗╚╝╠╣╦╩╬┌┐└┘├┤┬┴┼]/g, '+')
                        .replace(/[^\x20-\x7E]/g, ' ');
                    result += formatBMSLine('       DFHMDF POS=(' + (row + 1) + ',' + (currentCol + 1) + '),', true);
                    result += formatBMSLine('              LENGTH=' + actualLength + ',', true);
                    result += formatBMSLine('              ATTRB=(ASKIP,NORM),', true);
                    result += formatBMSLine("              INITIAL='" + safeChunk + "'");

                    remainingText = remainingText.substring(chunk.length).replace(/^\s+/, '');
                    currentCol += actualLength;
                }
                return result;
            }

            function createGroupedLabel(labels, rowNum) {
                var firstCol = labels[0].col;
                var fullText = '';
                var currentPos = firstCol;
                labels.forEach(function(label) {
                    while (currentPos < label.col) { fullText += ' '; currentPos++; }
                    fullText += label.text;
                    currentPos += label.text.length;
                });
                return { row: rowNum, col: firstCol, text: fullText };
            }

            var mapName    = screen.name.substring(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, '');
            var mapSetName = mapName + 'M';

            var bms = '';

            if (screen.bmsImported) {
                // Tela importada de BMS: reutilizar o bloco DFHMSD/DFHMDI original
                // Extrair do bmsSource original (se disponível) antes de ser zerado,
                // ou reconstruir a partir dos nomes originais preservados no screen
                var origHeader = _extractBMSHeader(screen);
                bms += origHeader;
            } else {
                bms += '* ========================================\n';
                bms += '* BMS MAP DEFINITION\n';
                bms += '* Tela: ' + screen.name + '\n';
                bms += '* ========================================\n\n';

                bms += formatBMSLine(mapName.padEnd(6) + ' DFHMSD LANG=COBOL,', true);
                bms += formatBMSLine('              MODE=INOUT,', true);
                bms += formatBMSLine('              STORAGE=AUTO,', true);
                bms += formatBMSLine('              TERM=3270,', true);
                bms += formatBMSLine('              TIOAPFX=YES,', true);
                bms += formatBMSLine('              TYPE=&SYSPARM');
                bms += '\n';
                bms += formatBMSLine(mapSetName.padEnd(6) + ' DFHMDI SIZE=(24,80),LINE=1,COLUMN=1');
                bms += '*\n';
            }

            // Coletar textos estáticos da tela
            var staticTexts = [];
            for (var row = 0; row < screen.data.length; row++) {
                var rowData = screen.data[row];
                var col = 0;
                var currentText = '';
                var textStartCol = 0;
                while (col < rowData.length) {
                    var ch = rowData[col];
                    var isField = screen.fields.some(function(f) {
                        return f.row === row && col >= f.col && col < f.col + f.length;
                    });
                    if (!isField && ch !== ' ') {
                        if (currentText === '') textStartCol = col;
                        currentText += ch;
                    } else {
                        if (currentText.trim()) {
                            staticTexts.push({ row: row, col: textStartCol, text: currentText.trim(), length: currentText.trim().length });
                        }
                        currentText = '';
                    }
                    col++;
                }
                if (currentText.trim()) {
                    staticTexts.push({ row: row, col: textStartCol, text: currentText.trim(), length: currentText.trim().length });
                }
            }

            // Agrupar labels da mesma linha sem campo entre eles
            var groupedLabels = [];
            var labelsByRow = {};
            staticTexts.forEach(function(label) {
                if (!labelsByRow[label.row]) labelsByRow[label.row] = [];
                labelsByRow[label.row].push(label);
            });
            Object.keys(labelsByRow).forEach(function(rowKey) {
                var labelsInRow = labelsByRow[rowKey].slice().sort(function(a, b) { return a.col - b.col; });
                var currentGroup = [labelsInRow[0]];
                for (var i = 1; i < labelsInRow.length; i++) {
                    var prevLbl = labelsInRow[i - 1];
                    var currLbl = labelsInRow[i];
                    var hasFieldBetween = screen.fields.some(function(f) {
                        return f.row === parseInt(rowKey) &&
                               f.col >= (prevLbl.col + prevLbl.length) &&
                               f.col < currLbl.col;
                    });
                    if (hasFieldBetween) {
                        groupedLabels.push(createGroupedLabel(currentGroup, parseInt(rowKey)));
                        currentGroup = [currLbl];
                    } else {
                        currentGroup.push(currLbl);
                    }
                }
                if (currentGroup.length > 0)
                    groupedLabels.push(createGroupedLabel(currentGroup, parseInt(rowKey)));
            });

            // Montar todos os elementos ordenados por linha/coluna
            var allElements = [];
            groupedLabels.forEach(function(label) {
                allElements.push({ type: 'label', row: label.row, col: label.col, text: label.text });
            });
            screen.fields.forEach(function(field, idx) {
                var varName = (field.bmsVariable || field.label || ('FLD' + (idx + 1)))
                    .toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8) || ('FLD' + (idx + 1));
                allElements.push({ type: 'field', row: field.row, col: field.col, field: field, name: varName });
            });
            allElements.sort(function(a, b) {
                if (a.row !== b.row) return a.row - b.row;
                return a.col - b.col;
            });

            allElements.forEach(function(element) {
                if (element.type === 'label') {
                    bms += generateTextDFHMDF(element.text, element.row, element.col);
                } else {
                    var field  = element.field;
                    var attrb  = getBMSAttrString(field);
                    // Limitar LENGTH ao máximo BMS-seguro: attr em col+1(1-idx), dados em col+2..80
                    var fieldBMSLength = Math.min(field.length, 79 - element.col);
                    var afterCol = element.col + fieldBMSLength + 2; // 1-indexed
                    // Comentários de campo apenas para telas não importadas
                    if (!screen.bmsImported) {
                        bms += '*      Campo: ' + (field.label || element.name) + '\n';
                    }
                    bms += formatBMSLine(element.name.padEnd(6) + ' DFHMDF POS=(' + (element.row + 1) + ',' + (element.col + 1) + '),', true);
                    bms += formatBMSLine('              LENGTH=' + fieldBMSLength + ',', true);
                    bms += formatBMSLine('              ATTRB=' + attrb);
                    // Só emitir trailing DFHMDF se couber dentro das 80 colunas
                    if (afterCol <= 80) {
                        bms += formatBMSLine('       DFHMDF POS=(' + (element.row + 1) + ',' + afterCol + '),', true);
                        bms += formatBMSLine('              LENGTH=0,', true);
                        bms += formatBMSLine('              ATTRB=ASKIP');
                    }
                    if (!screen.bmsImported) {
                        if (field.validationRules && field.validationRules.length > 0)
                            bms += '*      Validações: ' + field.validationRules.map(function(r) { return r.type; }).join(', ') + '\n';
                        if (field.isRequired)
                            bms += '*      CAMPO OBRIGATÓRIO\n';
                    }
                }
            });

            bms += '\n';
            bms += formatBMSLine('       DFHMSD TYPE=FINAL');
            bms += formatBMSLine('       END');
            return bms;
        }

        function syntaxHighlightBMS(code) {
            if (!code) return '';
            var fieldCount = {};
            return code.split('\n').map(function(line) {
                var esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                // Linha de comentário
                if (/^\s*\*/.test(line)) return '<span class="cc-comment">' + esc + '</span>';
                // Detectar linha de definição de campo: NOMECAMPO DFHMDF ...
                var fldMatch = line.match(/^([A-Z][A-Z0-9]{0,7})\s+DFHMDF\b/i);
                // Nomes de macros BMS
                esc = esc.replace(/\b(DFHMSD|DFHMDI|DFHMDF)\b/g, '<span class="cc-division">$1</span>');
                // Nomes de parâmetros BMS
                esc = esc.replace(/\b(LANG|MODE|STORAGE|TERM|TIOAPFX|TYPE|SIZE|LINE|COLUMN|POS|LENGTH|ATTRB|INITIAL)\b(?=\s*=)/g,
                    '<span class="cc-field">$1</span>');
                // Literais entre aspas simples
                esc = esc.replace(/'([^']*)'/g, '<span class="cc-string">\'$1\'</span>');
                // Valores de atributos BMS e opções de parâmetros
                esc = esc.replace(/\b(UNPROT|PROT|ASKIP|NUM|BRT|DRK|NORM|IC|FSET|FINAL|INOUT|COBOL|AUTO|YES|3270)\b/g,
                    '<span class="cc-number">$1</span>');
                // &SYSPARM (escapado como &amp;SYSPARM)
                esc = esc.replace(/&amp;SYSPARM/g, '<span class="cc-number">&amp;SYSPARM</span>');
                // Envolver linha de campo com âncora para outline BMS
                if (fldMatch) {
                    var fname = fldMatch[1].toUpperCase();
                    fieldCount[fname] = (fieldCount[fname] || 0) + 1;
                    var anchorId = 'bms-ol-' + fname + (fieldCount[fname] > 1 ? '-' + fieldCount[fname] : '');
                    esc = '<span id="' + anchorId + '" class="bms-fld-anchor cc-division-header">' + esc + '</span>';
                }
                return esc;
            }).join('\n');
        }

        function updateCodePanel(scrollToNav) {
            var el          = document.getElementById('cobolCodeOutput');
            var propPanel   = document.getElementById('propPanel');
            var outlineWrap = document.getElementById('cobolOutlineWrap');
            var subTabs     = document.getElementById('viewCodeSubTabs');
            if (!el) return;
            var screen = (app.currentScreenIndex >= 0 ? app.screens[app.currentScreenIndex] : null) || null;
            var rulesForScreen = screen ? app.navigationRules.filter(function(r) { return r.fromScreen === screen.id; }) : [];
            console.log('[COBOL] updateCodePanel | tela:', screen ? screen.name : 'nenhuma',
                        '| idx:', app.currentScreenIndex,
                        '| regras totais:', app.navigationRules.length,
                        '| regras da tela:', rulesForScreen.length);
            var mainTab   = app.activeMainTab || 'viewcode';
            var activeTab = app.activeCodeTab || 'cics';
            if (subTabs) subTabs.style.display = mainTab === 'viewcode' ? '' : 'none';

            /* Painel Propriedade */
            if (mainTab === 'propriedade') {
                el.style.display = 'none';
                if (outlineWrap) outlineWrap.style.display = 'none';
                if (propPanel) {
                    propPanel.style.display = '';
                    if (!screen) {
                        propPanel.innerHTML = '<div class="prop-empty">Nenhuma tela carregada</div>';
                    } else {
                        var numFields  = screen.fields ? screen.fields.length : 0;
                        var numNumeric = screen.fields ? screen.fields.filter(function(f){ return f.type === 'numeric'; }).length : 0;
                        var numAlpha   = screen.fields ? screen.fields.filter(function(f){ return f.type === 'alpha'; }).length : 0;
                        var myRules = app.navigationRules.filter(function(r){ return r.fromScreen === screen.id; });

                        /* Seção expansível de Campos e Validações */
                        var fieldsRows = '';
                        if (app.fields && app.fields.length > 0) {
                            fieldsRows = app.fields.map(function(f, i) {
                                var label    = f.label || ('Campo ' + (i + 1));
                                var bmsVar   = f.bmsVariable ? f.bmsVariable : '—';
                                var tipo     = f.type === 'numeric' ? 'Numérico' : 'Alfanum.';
                                var valCount = f.validationRules ? f.validationRules.length : 0;
                                var obrigTag = f.isRequired ? '<span class="prop-field-tag prop-field-tag-req">Obrigatório</span>' : '';
                                var valTag   = valCount > 0
                                    ? '<span class="prop-field-tag prop-field-tag-val">' + valCount + ' validação(ões)</span>'
                                    : '<span class="prop-field-tag prop-field-tag-off">Sem validação</span>';
                                var bmsTag   = f.bmsVariable
                                    ? '<span class="prop-field-tag prop-field-tag-bms">' + f.bmsVariable + '</span>'
                                    : '<span class="prop-field-tag prop-field-tag-off">Sem BMS</span>';
                                return '<div class="prop-field-row prop-field-row-edit" onclick="openCamposPanelWithField(' + i + ')">' +
                                    '<div class="prop-field-row-top">' +
                                        '<div class="prop-field-name">' + label + '</div>' +
                                        '<button class="prop-field-edit-btn" onclick="event.stopPropagation(); editFieldLabel(' + i + ')" title="Alterar nome do campo">✏️ Editar</button>' +
                                    '</div>' +
                                    '<div class="prop-field-meta">Ln ' + (f.row + 1) + ', Col ' + (f.col + 1) + ' | ' + tipo + ' | Tam: ' + f.length + '</div>' +
                                    '<div class="prop-field-tags">' + bmsTag + valTag + obrigTag + '</div>' +
                                '</div>';
                            }).join('');
                        } else {
                            fieldsRows = '<div class="prop-field-empty">Nenhum campo detectado</div>';
                        }

                        propPanel.innerHTML =
                            '<table class="prop-table">' +
                            '<tr><td class="prop-key">Nome</td><td class="prop-val">' + (screen.name || '—') + '</td></tr>' +
                            '<tr><td class="prop-key">Origem</td><td class="prop-val">' + (screen.sourceFile || '—') + '</td></tr>' +
                            '<tr><td class="prop-key">Dimensões</td><td class="prop-val">24 × 80</td></tr>' +
                            '<tr><td class="prop-key">Total de campos</td><td class="prop-val">' + numFields + '</td></tr>' +
                            '<tr><td class="prop-key">Campos numéricos</td><td class="prop-val">' + numNumeric + '</td></tr>' +
                            '<tr><td class="prop-key">Campos alfanum.</td><td class="prop-val">' + numAlpha + '</td></tr>' +
                            '<tr><td class="prop-key">Regras de navegação</td><td class="prop-val">' + myRules.length + '</td></tr>' +
                            '<tr><td class="prop-key">Índice</td><td class="prop-val">' + (app.currentScreenIndex + 1) + ' / ' + app.screens.length + '</td></tr>' +
                            '</table>' +
                            '<div class="prop-section-toggle" onclick="togglePropSection(\'campos\')" id="propToggleCampos">' +
                                '<span class="prop-toggle-arrow" id="propArrowCampos">▶</span>' +
                                '<span>Campos e Validações</span>' +
                                '<span class="prop-toggle-count">(' + numFields + ')</span>' +
                            '</div>' +
                            '<div class="prop-section-body" id="propBodyCampos" style="display:none;">' +
                                fieldsRows +
                            '</div>' +
                            '<div class="prop-section-toggle" onclick="togglePropSection(\'valkeys\')" id="propToggleValkeys">' +
                                '<span class="prop-toggle-arrow" id="propArrowValkeys">▶</span>' +
                                '<span>Teclas que Validam</span>' +
                                '<span class="prop-toggle-count">(' + (app.validationKeys ? app.validationKeys.length : 1) + ')</span>' +
                            '</div>' +
                            '<div class="prop-section-body" id="propBodyValkeys" style="display:none;">' +
                                '<div class="prop-valkeys-grid">' + (function(){
                                    var allKeys = ['ENTER','PF1','PF2','PF3','PF4','PF5','PF6','PF7','PF8','PF9','PF10','PF11','PF12'];
                                    var active  = app.validationKeys || ['ENTER'];
                                    return allKeys.map(function(k){
                                        var on = active.indexOf(k) >= 0;
                                        return '<span class="prop-val-key' + (on ? ' prop-val-key-on' : '') + '" onclick="togglePropValKey(\'' + k + '\')" title="' + (on ? 'Clique para desativar' : 'Clique para ativar') + '">' + k + '</span>';
                                    }).join('');
                                })() + '</div>' +
                            '</div>';
                    }
                }
                /* badge — ocultar no painel Propriedade */
                var badge = document.getElementById('cobolUpdateBadge');
                if (badge) {
                    badge.textContent = '';
                    badge.style.display = 'none';
                }
                buildOutlineNav();
                return;
            }

            /* Tabs CICS / BMS */
            el.style.display = '';
            if (propPanel) propPanel.style.display = 'none';
            /* preservar posição do scroll (a menos que seja nav update) */
            var prevScroll = scrollToNav ? -1 : el.scrollTop;
            try {
                if (activeTab === 'bms') {
                    const bmsText = (screen && screen.bmsSource)
                        ? screen.bmsSource
                        : generateBMSCode(screen);
                    el.innerHTML = _wrapCodeLines(syntaxHighlightBMS(bmsText));
                } else {
                    el.innerHTML = _wrapCodeLines(syntaxHighlightCobol(generateCobolCode(screen)));
                }
            } catch(e) {
                console.error('[COBOL] Erro ao gerar código:', e);
                el.textContent = '      * ERRO AO GERAR CÓDIGO: ' + e.message;
            }
            if (!scrollToNav) {
                el.scrollTop = prevScroll;
            }
            /* feedback visual no header */
            var badge = document.getElementById('cobolUpdateBadge');
            if (badge) {
                badge.style.display = '';
                var activeTabBadge = app.activeCodeTab || 'cics';
                if (activeTabBadge === 'bms') {
                    var fieldCount = screen ? screen.fields.length : 0;
                    badge.textContent = fieldCount + ' campo(s)';
                    badge.classList.toggle('badge-bms-active',  fieldCount > 0);
                    badge.classList.toggle('badge-bms-empty',   fieldCount === 0);
                    badge.classList.remove('badge-cics-active', 'badge-cics-empty');
                    badge.style.background = '';
                } else {
                    badge.textContent = rulesForScreen.length + ' regra(s)';
                    badge.classList.toggle('badge-cics-active',  rulesForScreen.length > 0);
                    badge.classList.toggle('badge-cics-empty',   rulesForScreen.length === 0);
                    badge.classList.remove('badge-bms-active',  'badge-bms-empty');
                    badge.style.background = '';
                }
            }
            buildOutlineNav();
        }

        /* Constrói o dropdown de navegação rápida por DIVISION/SECTION (COBOL) ou campo (BMS) */
        function buildOutlineNav() {
            var pre  = document.getElementById('cobolCodeOutput');
            var sel  = document.getElementById('cobolOutlineNav');
            var wrap = document.getElementById('cobolOutlineWrap');
            if (!pre || !sel || !wrap) return;

            /* Ocultar outline no painel Propriedade */
            if ((app.activeMainTab || 'viewcode') === 'propriedade') {
                sel.innerHTML = '';
                wrap.style.display = 'none';
                return;
            }

            var activeTab = app.activeCodeTab || 'cics';

            if (activeTab === 'bms') {
                /* ── modo BMS: listar campos por nome de variável ── */
                var anchors = pre.querySelectorAll('.bms-fld-anchor');
                if (anchors.length === 0) {
                    sel.innerHTML = '';
                    wrap.style.display = 'none';
                    return;
                }
                sel.innerHTML = '<option value="">⬇ Ir para campo BMS...</option>';
                for (var k = 0; k < anchors.length; k++) {
                    var opt = document.createElement('option');
                    opt.value = anchors[k].id;
                    opt.textContent = anchors[k].id.replace(/^bms-ol-/, '').replace(/-\d+$/, '');
                    sel.appendChild(opt);
                }
                sel.value = '';
                wrap.style.display = 'block';
                return;
            }

            /* ── modo COBOL: divisões/seções ── */
            /* limpar ids antigos */
            var old = pre.querySelectorAll('[id^="ol-"]');
            for (var i = 0; i < old.length; i++) old[i].removeAttribute('id');
            var headers = pre.querySelectorAll('.cc-division-header');
            if (headers.length === 0) {
                sel.innerHTML = '';
                wrap.style.display = 'none';
                return;
            }
            sel.innerHTML = '<option value="">⬇ Ir para divisão / seção...</option>';
            for (var j = 0; j < headers.length; j++) {
                var id = 'ol-' + j;
                headers[j].id = id;
                var optC = document.createElement('option');
                optC.value = id;
                optC.textContent = headers[j].textContent.trim();
                sel.appendChild(optC);
            }
            sel.value = '';
            wrap.style.display = 'block';
        }

        /* Salta para a divisão selecionada no outline dropdown */
        function jumpToOutlineSection(id) {
            if (!id) return;
            var span = document.getElementById(id);
            var pre  = document.getElementById('cobolCodeOutput');
            if (!span || !pre) return;
            /* calcula posição relativa ao container rolável */
            var spanTop = span.getBoundingClientRect().top;
            var preTop  = pre.getBoundingClientRect().top;
            pre.scrollTop = pre.scrollTop + (spanTop - preTop) - 8;
            var sel = document.getElementById('cobolOutlineNav');
            if (sel) setTimeout(function() { sel.value = ''; }, 600);
        }

        function updateScreenFieldsCount() {
            if (app.currentScreenIndex < 0) return;
            var screen = app.screens[app.currentScreenIndex];
            var editableFields = ((screen && screen.fields) || []).filter(function(f) { return f.row !== 0; });
            var numEl  = document.getElementById('fieldsCountNum');
            var dispEl = document.getElementById('fieldsCountDisplay');
            if (numEl)  numEl.textContent = editableFields.length;
            if (dispEl) dispEl.style.display = editableFields.length > 0 ? 'inline' : 'none';
        }

        function clearAllScreens() {
            if (app.screens.length === 0) {
                showMessage('Nenhuma tela para limpar', 'error');
                return;
            }
            if (!confirm('Limpar TODAS as telas e regras de navegacao?')) return;
            app.screens = [];
            app.navigationRules = [];
            app.currentScreenIndex = -1;
            app.fields = [];
            initTerminal();
            updateScreensList();
            updateScreenInfo();
            updateCodePanel();
            var fc = document.getElementById('fieldsCountDisplay');
            if (fc) fc.style.display = 'none';
            showMessage('Todas as telas limpas', 'success');
        }

        /* ═══════════════════════════════════════════
           PAINÉIS REDIMENSIONÁVEIS — drag to resize
           ═══════════════════════════════════════════ */
        function setupResizeHandle(handleId, panelSelector, side) {
            var handle = document.getElementById(handleId);
            if (!handle) return;
            var panel  = document.querySelector(panelSelector);
            if (!panel)  return;

            var dragging = false;
            var startX   = 0;
            var startW   = 0;
            var minW     = parseInt(getComputedStyle(panel).minWidth) || 130;

            handle.addEventListener('mousedown', function(e) {
                dragging = true;
                startX   = e.clientX;
                startW   = panel.getBoundingClientRect().width;
                handle.classList.add('dragging');
                document.body.style.cursor      = 'col-resize';
                document.body.style.userSelect  = 'none';
                e.preventDefault();
            });

            document.addEventListener('mousemove', function(e) {
                if (!dragging) return;
                /* side='left'  → arrastar para direita amplia o painel esquerdo
                   side='right' → arrastar para esquerda amplia o painel direito */
                var delta = side === 'left'
                    ? e.clientX - startX
                    : startX - e.clientX;
                var newW = Math.max(minW, startW + delta);
                panel.style.width = newW + 'px';
                if (window.fitTerminal) window.fitTerminal();
            });

            document.addEventListener('mouseup', function() {
                if (!dragging) return;
                dragging = false;
                handle.classList.remove('dragging');
                document.body.style.cursor     = '';
                document.body.style.userSelect = '';
            });
        }

        document.addEventListener('DOMContentLoaded', function() {
            setupResizeHandle('resizeLeft',  '.ide-sidebar',     'left');
            setupResizeHandle('resizeRight', '.ide-code-panel',  'right');
        });

        /* ═══════════════════════════════════════════════════
           AUTO-ESCALA DO TERMINAL — cabe sempre no painel
           ═══════════════════════════════════════════════════ */
        (function initFitTerminal() {
            var TERM_W = 720;   /* 80 colunas × 9px  */
            var TERM_H = 432;   /* 24 linhas  × 18px */
            var SBAR_H = 30;    /* altura da status-bar */
            var PAD    = 24;    /* margem interna do viewport */

            function fitTerminal() {
                var viewport = document.getElementById('terminalViewport');
                var wrap     = document.getElementById('terminalWrap');
                if (!viewport || !wrap) return;

                var vw = viewport.clientWidth  - PAD;
                var vh = viewport.clientHeight - PAD;
                var natural_h = TERM_H + SBAR_H;

                /* escala para caber na largura E na altura — nunca ampliar */
                var scale = Math.min(vw / TERM_W, vh / natural_h, 1);
                scale = Math.max(0.30, scale);

                wrap.style.transform    = 'scale(' + scale + ')';
                /* compensa o espaço que transform:scale deixa em branco */
                wrap.style.marginBottom = Math.round(natural_h * (scale - 1)) + 'px';
            }

            document.addEventListener('DOMContentLoaded', function() {
                fitTerminal();
                /* re-escala quando a janela ou os painéis mudam de tamanho */
                var vp = document.getElementById('terminalViewport');
                if (vp && window.ResizeObserver) {
                    new ResizeObserver(fitTerminal).observe(vp);
                }
                window.addEventListener('resize', fitTerminal);
            });

            /* expor para chamadas externas (ex: após arrastar resize-handle) */
            window.fitTerminal = fitTerminal;
        }());