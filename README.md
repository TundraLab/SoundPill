<p align="center">
  <img src="./icons/tundra-media-pill.svg" alt="Tundra Media Pill" width="96" />
</p>

# Tundra Media Pill v3.2.5

[![GitHub](https://img.shields.io/badge/GitHub-TundraLab%2FTundra--Media--Pill-181717?logo=github)](https://github.com/TundraLab/Tundra-Media-Pill)
[![Autor Único](https://img.shields.io/badge/Autor%20e%20Dev%20Único-%40GustaHerin-181717?logo=github)](https://github.com/GustaHerin)
[![Fedora](https://img.shields.io/badge/Fedora-Workstation-51A2DA?logo=fedora&logoColor=white)](#compatibilidade)
[![Pop!_OS](https://img.shields.io/badge/Pop!__OS-GNOME-48B9C7?logo=popos&logoColor=white)](#compatibilidade)
[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-47%20%2F%2051-4A86CF?logo=gnome&logoColor=white)](#compatibilidade)
[![Wayland & X11](https://img.shields.io/badge/Wayland%20%26%20X11-Suportado-2C7FB8?logo=linux&logoColor=white)](#compatibilidade)
[![GJS / GTK4](https://img.shields.io/badge/GJS-GTK4%20%2F%20Libadwaita-4A86CF?logo=gtk&logoColor=white)](#como-instalar)
[![Licença](https://img.shields.io/badge/License-All%20Rights%20Reserved-red)](LICENSE)

Produto oficial da **TundraLab**, criado e desenvolvido de forma independente e individual por **Gustavo Henrique Novaes Gomes ([@GustaHerin](https://github.com/GustaHerin))**.

Extensão de mídia para a barra superior do GNOME com controles de reprodução, capa em vinil, letras sincronizadas, waveform personalizável e widget na área de trabalho.

Repositório oficial: https://github.com/TundraLab/Tundra-Media-Pill

---

## Capturas de tela

### Pílula na barra superior

![Pílula na barra superior](./screenshots/pill-bar.png)

### Menu do player, widget na área de trabalho e configurações

| Card no menu com letras sincronizadas | Widget na área de trabalho | Configurações e idiomas |
| :---: | :---: | :---: |
| ![Card no menu com letras sincronizadas](./screenshots/player-card.jpg) | ![Widget na área de trabalho](./screenshots/desktop-widget.jpg) | ![Configurações](./screenshots/settings.jpg) |

---

## O que ela faz

- **Controla qualquer mídia tocando no PC**: funciona com Spotify, YouTube no navegador, VLC, Rhythmbox e outros players via MPRIS2.
- **Clique na capa para ir até o player**: clicar na capa do álbum abre ou foca a janela onde a música está tocando.
- **Letra sincronizada ao vivo**: mostra o verso atual direto na barra superior e acompanha a faixa no painel de letras via LRCLIB (com rolagem automática também para letras sem timestamp).
- **10 estilos de waveform e 7 estilos na pílula**: barras clássicas, reflexo SoundCloud, equalizador LED, partículas, slider, matriz retrô, osciloscópio, fita de pulso, batimento ECG e trilho estéreo.
- **Paleta com 13 cores ou cor da capa**: escolha uma cor de destaque fixa ou extraia automaticamente da capa do álbum.
- **Widget na área de trabalho**: fixe o card completo no papel de parede ou sempre visível acima das janelas, com opção de arrastar e travar posição.
- **Português e English**: selecione o idioma direto nas configurações ou siga o idioma do sistema.

---

## Compatibilidade

- **GNOME 47, 48, 49, 50 e 51** (Fedora Workstation, Pop!_OS, Ubuntu, Arch Linux e demais distribuições com GNOME).
- Suporte completo a **Wayland** e **X11**.

---

## Como instalar

### Instalação rápida via terminal (recomendado)

Execute o comando abaixo no terminal para baixar, compilar o esquema e instalar a extensão automaticamente:

```bash
curl -fsSL https://raw.githubusercontent.com/TundraLab/Tundra-Media-Pill/main/install.sh | bash
```

> **Para desinstalar:**
> ```bash
> curl -fsSL https://raw.githubusercontent.com/TundraLab/Tundra-Media-Pill/main/install.sh | bash -s -- --uninstall
> ```

### Instalação manual pelo código-fonte

```bash
git clone https://github.com/TundraLab/Tundra-Media-Pill.git
cd Tundra-Media-Pill
chmod +x install.sh
./install.sh --copy
```

Após instalar, **reinicie a sessão** (faça logout e entre novamente no sistema; no X11, pressione `Alt + F2`, digite `r` e aperte `Enter`).

Pronto! A extensão já ficará ativada e configurada para iniciar sozinha sempre que você ligar o Linux.

---

## Como usar e configurar

- **Na barra superior**: clique na pílula quando estiver ouvindo algo para abrir o player completo, controlar a reprodução e ver a letra.
- **Na área de trabalho**: clique no ícone de pino dentro do menu do player para fixar ou remover o widget da área de trabalho. Você pode arrastá-lo pela tela ou travar a posição pelo cadeado.
- **Configurações**: abra o aplicativo **Extensões** do GNOME e clique na engrenagem ao lado de **Tundra Media Pill** (ou no botão de configurações dentro do próprio player).

---

## Licença e Propriedade Intelectual

**Todos os Direitos Reservados (`All Rights Reserved`)**  
Copyright © 2026 **TundraLab** e **Gustavo Henrique Novaes Gomes** ([@GustaHerin](https://github.com/GustaHerin)).

Produto proprietário da **TundraLab**, concebido e desenvolvido de forma independente por seu autor único. Consulte o arquivo [LICENSE](./LICENSE) para mais detalhes. É proibida a cópia, modificação ou redistribuição sem autorização prévia por escrito.
