/** 测试环境：先于服务端模块加载设置快速超时 */
process.env.NODE_ENV = 'test';
process.env.TURN_TIMEOUT_MS = '200';
process.env.CLAIM_TIMEOUT_MS = '120';
process.env.AI_DELAY_MS = '10';
export {};
