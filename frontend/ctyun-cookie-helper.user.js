// ==UserScript==
// @name         云电脑 AI Token 助手
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  在云电脑 AI 页面右下角显示 YL-Token 并支持一键复制
// @author       YourName
// @match        https://eaichat.ctyun.cn/chat/
// @match        https://eaichat.ctyun.cn/chat/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // 获取 Cookie
    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    // 创建悬浮卡片 UI
    function createTokenPanel(token) {
        // 如果已经存在面板则不再创建
        if (document.getElementById('token-helper-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'token-helper-panel';
        
        // 采用互联网大厂主流的扁平化、高圆角、轻量微阴影风格
        panel.style = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 99999;
            background: #ffffff;
            padding: 14px 18px;
            border-radius: 12px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            align-items: center;
            gap: 12px;
            border: 1px solid #f0f0f0;
            transition: all 0.3s ease;
        `;

        // 文本标签
        const label = document.createElement('span');
        label.innerText = 'YL-Token';
        label.style = `
            font-size: 13px;
            font-weight: 600;
            color: #4e5969;
            background: #f2f3f5;
            padding: 4px 8px;
            border-radius: 6px;
        `;

        // Token 预览（截取前后，防止过长撑爆页面）
        const preview = document.createElement('span');
        preview.innerText = token.length > 15 ? `${token.substring(0, 8)}...${token.substring(token.length - 8)}` : token;
        preview.style = `
            font-size: 13px;
            color: #1d2129;
            font-family: monospace;
        `;

        // 复制按钮
        const copyBtn = document.createElement('button');
        copyBtn.innerText = '复制';
        copyBtn.style = `
            background: #1677ff;
            color: #ffffff;
            border: none;
            padding: 5px 12px;
            border-radius: 6px;
            font-size: 13px;
            cursor: pointer;
            font-weight: 500;
            transition: background 0.2s;
        `;
        
        // 按钮悬浮效果
        copyBtn.onmouseenter = () => copyBtn.style.background = '#4096ff';
        copyBtn.onmouseleave = () => {
            if (copyBtn.innerText === '复制') copyBtn.style.background = '#1677ff';
        };

        // 复制逻辑
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(token).then(() => {
                copyBtn.innerText = '已复制';
                copyBtn.style.background = '#52c41a'; // 成功绿
                
                setTimeout(() => {
                    copyBtn.innerText = '复制';
                    copyBtn.style.background = '#1677ff';
                }, 2000);
            }).catch(err => {
                console.error('复制失败:', err);
                // 备用复制方案
                const textarea = document.createElement('textarea');
                textarea.value = token;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                
                copyBtn.innerText = '已复制';
                copyBtn.style.background = '#52c41a';
                setTimeout(() => {
                    copyBtn.innerText = '复制';
                    copyBtn.style.background = '#1677ff';
                }, 2000);
            });
        };

        // 组装并写入页面
        panel.appendChild(label);
        panel.appendChild(preview);
        panel.appendChild(copyBtn);
        document.body.appendChild(panel);
    }

    // 初始化检查
    window.addEventListener('load', () => {
        // 定时轮询，直到拿到 Token 为止（适配异步登录写入的情况）
        const checkTimer = setInterval(() => {
            const token = getCookie('YL-Token');
            if (token) {
                createTokenPanel(token);
                clearInterval(checkTimer); // 拿到后停止轮询
            }
        }, 1000);

        // 最多寻找 10 秒，超时自动停止防止死循环
        setTimeout(() => clearInterval(checkTimer), 10000);
    });
})();
