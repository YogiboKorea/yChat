const fs = require('fs');
const filepath = 'c:/Users/Yogibo Design/Desktop/yogiChat/public/game.html';
let content = fs.readFileSync(filepath, 'utf8');

// 1. Fix Background Swap Bug (The server filenames are swapped, so we need to map .success to 실패_bg.png and .fail to 성공_bg.png)
content = content.replace(
    /#screen-result\.success\s*\{\s*background:\s*url\('http:\/\/yogibo\.kr\/game\/성공_bg\.png'\)/, 
    `#screen-result.success { background: url('http://yogibo.kr/game/실패_bg.png')`
);
content = content.replace(
    /#screen-result\.fail\s*\{\s*background:\s*url\('http:\/\/yogibo\.kr\/game\/실패_bg\.png'\)/, 
    `#screen-result.fail { background: url('http://yogibo.kr/game/성공_bg.png')`
);

// 2. Fix Stale Text Bug (Clear or explicitly set textBox.innerText on success)
if (!content.includes("textBox.innerText = '축하합니다~\\n요기보에 누울 자격 획득!';")) {
    content = content.replace(
        /if \(isSuccess\) \{\s*resultScreen\.classList\.add\('success'\);\s*banner\.src = 'http:\/\/yogibo\.kr\/game\/성공_텍스트\.png';\s*charImg\.src = d\.success;/,
        `if (isSuccess) {\n                resultScreen.classList.add('success');\n                banner.src = 'http://yogibo.kr/game/성공_텍스트.png';\n                charImg.src = d.success;\n                textBox.innerText = '축하합니다~\\n요기보에 누울 자격 획득!';`
    );
}

// 3. To also fix the coloring of the textBox on success vs fail:
// On fail, it is a white text usually, but wait, the text in the success screen is white too.
// The user screenshot in step 226 shows white text. So it's fine.

fs.writeFileSync(filepath, content);
console.log('Fixed success background mapping and text state persistence.');
