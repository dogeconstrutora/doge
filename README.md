# Apartment Status Dashboard


O **Apartment Status Dashboard** é uma aplicação web interativa desenvolvida para visualizar e gerenciar o status de apartamentos em um projeto de construção ou inspeção. Com uma interface intuitiva, a aplicação permite filtrar e destacar apartamentos com base em seu progresso, pendências e não conformidades, utilizando uma representação visual colorida e organizada. Construído com HTML, CSS e JavaScript puro, o projeto é leve, modular e fácil de integrar.

## Funcionalidades

- **Visualização de Status com Cores**:
  - **Azul** (#4493f8): Apartamentos em andamento (sem `data_termino_inicial`).
  - **Amarelo** (#e3b341): Apartamentos finalizados com pendências (`qtd_pend_ultima_inspecao > 0`).
  - **Vermelho** (#f85149): Apartamentos com não conformidades (`qtd_nao_conformidades_ultima_inspecao > 0`).
  - **Verde** (#3fb950): Apartamentos finalizados perfeitamente (100% concluídos, sem pendências ou NC).
  - **Cinza** (#6b7280): Apartamentos sem dados ou finalizados (usado como padrão).

- **Filtros Interativos**:
  - **Modo "Em Andamento"**: Exibe apenas apartamentos em andamento (azuis), com pendências (amarelos) ou com não conformidades (vermelhos), ocultando os finalizados perfeitamente (verdes). O botão usa um círculo verde (inativo) que muda para cinza (ativo) com um efeito brilhante.
  - **Modo "NC" (Não Conformidades)**: Destaca apartamentos com não conformidades em vermelho, ocultando os demais.
  - **Seleção de Pavimento**: Um dropdown permite filtrar apartamentos por pavimento, mantendo a visualização focada.

- **Interface de Cartões 2D**:
  - Exibe cartões para cada apartamento com informações detalhadas (pendências, NC, percentual concluído, duração).
  - Cartões são coloridos de acordo com o status e interativos, com suporte a cliques para mais detalhes.

- **Preservação de Estado**:
  - Preferências do usuário (modo NC, modo Em Andamento, pavimento selecionado) são salvas localmente usando `prefs.js`.
  - A posição de rolagem da visualização 2D é preservada ao alternar filtros.

- **Acessibilidade**:
  - Botões com `aria-label` e `aria-pressed` para compatibilidade com leitores de tela.
  - Títulos descritivos (`title`) para botões, garantindo clareza para todos os usuários.

## Tecnologias Utilizadas

- **HTML5**: Estrutura da interface, incluindo botões e contêineres para cartões.
- **CSS3**: Estilização responsiva com transições suaves, bordas brilhantes e design moderno (usando `clamp` para escalabilidade).
- **JavaScript (ES6+)**: Lógica de filtros, manipulação de dados e renderização dinâmica.
  - **Módulos**: `hud.js` (eventos de UI), `overlay2d.js` (renderização de cartões 2D), `colors.js` (lógica de cores), `state.js` (gerenciamento de estado), `qs.js` (query string), `prefs.js` (preferências), `fvs.js` (seleção de pavimento), `render.js` (renderização geral).

## Como Executar

### Pré-requisitos
- Um navegador moderno (Chrome, Firefox, Edge, etc.).
- Um servidor web local (ex.: `http-server`, Live Server no VS Code) para carregar os arquivos corretamente devido ao uso de módulos ES6.

### Passos
1. Clone o repositório:
   ```bash
   git clone https://github.com/seu-usuario/apartment-status-dashboard.git
   cd apartment-status-dashboard
