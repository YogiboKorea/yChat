const fs = require('fs');
const filepath = 'c:/Users/Yogibo Design/Desktop/yogiChat/public/game.html';
let content = fs.readFileSync(filepath, 'utf8');

// Ensure label-row items are vertically aligned
content = content.replace(
    /\.label-row\s*\{[\s\S]*?margin-bottom:\s*15px;\s*\}/,
    `.label-row {\n            display: flex;\n            gap: 12px;\n            width: 90%;\n            justify-content: space-between;\n            align-items: center;\n            margin-bottom: 15px;\n        }`
);

// Scale up Fox image to compensate for wide transparent padding that pushes it down visually
if (!content.includes('data-char="fox"')) {
    content = content.replace(
        /<\/style>/,
        `
        /* 팍스(Fox) 이미지 여백 보정 */
        .char-label[data-char="fox"] { margin-top: 0 !important; }
        .character-card[data-char="fox"] img {
            transform: scale(1.15) translateY(-5px);
        }
        .character-card[data-char="fox"].active img {
            transform: scale(1.2) translateY(-10px);
            filter: drop-shadow(0 0 8px rgba(59, 200, 216, 0.8));
        }
    </style>`
    );
}

fs.writeFileSync(filepath, content);
console.log('Fixed Fox alignment.');
