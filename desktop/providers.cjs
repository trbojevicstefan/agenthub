'use strict';

// OpenAI-compatible provider presets shared with the renderer through the service snapshot.
// The short model lists make a new connection usable before authentication; once connected,
// the Models dialog refreshes the authoritative inventory from the provider's /models route.
const PROVIDERS={
  hermes:{label:'Hermes',endpoint:'http://127.0.0.1:8642/v1',models:['hermes-agent']},
  codex:{label:'Codex',protocol:'codex',transport:'local',command:'codex',models:[]},
  claude:{label:'Claude Code',protocol:'claude',transport:'local',command:'claude',models:[]},
  openclaw:{label:'OpenClaw',endpoint:'http://127.0.0.1:18789/v1',models:['openclaw/default']},
  deepseek:{label:'DeepSeek',endpoint:'https://api.deepseek.com/v1',models:['deepseek-v4-pro','deepseek-v4-flash']},
  openai:{label:'OpenAI',endpoint:'https://api.openai.com/v1',models:[]},
  google:{label:'Google Gemini',endpoint:'https://generativelanguage.googleapis.com/v1beta/openai',models:['gemini-3.8-flash']},
  openrouter:{label:'OpenRouter',endpoint:'https://openrouter.ai/api/v1',models:['~openai/gpt-latest']},
  xai:{label:'xAI',endpoint:'https://api.x.ai/v1',models:['grok-4.7','grok-4']},
  groq:{label:'Groq',endpoint:'https://api.groq.com/openai/v1',models:['openai/gpt-oss-120b','openai/gpt-oss-20b','qwen/qwen3.8-27b','minimaxai/minimax-m2.7']},
  mistral:{label:'Mistral',endpoint:'https://api.mistral.ai/v1',models:['mistral-large-latest','mistral-small-latest','codestral-latest']},
  ollama:{label:'Ollama',endpoint:'http://127.0.0.1:11434/v1',models:[]},
  lmstudio:{label:'LM Studio',endpoint:'http://127.0.0.1:1234/v1',models:[]},
  custom:{label:'Custom API',endpoint:'http://127.0.0.1:1234/v1',models:[]}
};

const HTTP_PROVIDERS=new Set(Object.entries(PROVIDERS).filter(([,p])=>!p.protocol||p.protocol==='openai').map(([id])=>id));

module.exports={PROVIDERS,HTTP_PROVIDERS};
