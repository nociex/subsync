/**
 * 同步订阅脚本
 * 用于从配置的订阅源获取数据，转换为目标格式并保存
 */

// 导入依赖
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SubscriptionConverter } from '../converter/SubscriptionConverter.js';
import { NodeTester } from '../tester/NodeTester.js';
import yaml from 'js-yaml';
import { BarkNotifier } from '../utils/events/BarkNotifier.js';
import { eventEmitter, EventType } from '../utils/events/index.js';
import { HttpsProxyAgent } from 'https-proxy-agent'; // 需要引入

// 设置 ES 模块中的 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置日志级别
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
console.log(`[Logger] Setting log level to: ${LOG_LEVEL}`);
const DEBUG = LOG_LEVEL === 'debug';

// 获取项目根目录
const rootDir = path.resolve(__dirname, '../..');
console.log(`项目根目录: ${rootDir}`);

// --- 国内代理缓存配置 ---
const CHINA_PROXY_CACHE_PATH = path.resolve(rootDir, 'data/ip_cache/china_proxies.json');
let loadedChinaProxies = []; // 缓存加载的代理
let currentProxyIndex = 0;

// 确保缓存目录存在
ensureDirectoryExists(path.dirname(CHINA_PROXY_CACHE_PATH));

// 加载国内代理缓存
function loadChinaProxies() {
  try {
    if (fs.existsSync(CHINA_PROXY_CACHE_PATH)) {
      const content = fs.readFileSync(CHINA_PROXY_CACHE_PATH, 'utf-8');
      const proxies = JSON.parse(content);
      if (Array.isArray(proxies)) {
        console.log(`成功从 ${CHINA_PROXY_CACHE_PATH} 加载 ${proxies.length} 个国内代理缓存`);
        return proxies.filter(p => typeof p === 'string' && p.startsWith('http')); // 基本验证
      }
    }
  } catch (error) {
    console.error(`加载国内代理缓存失败: ${error.message}`);
  }
  console.log('未找到或无法加载国内代理缓存文件。');
  return [];
}

// 保存国内代理缓存
function saveChinaProxies(proxies) {
  try {
    // 只保存有效的 HTTP/HTTPS 代理 URL
    const validProxies = proxies.filter(p => typeof p === 'string' && p.startsWith('http'));
    fs.writeFileSync(CHINA_PROXY_CACHE_PATH, JSON.stringify(validProxies, null, 2));
    console.log(`已将 ${validProxies.length} 个国内代理缓存保存到 ${CHINA_PROXY_CACHE_PATH}`);
  } catch (error) {
    console.error(`保存国内代理缓存失败: ${error.message}`);
  }
}

// 提供国内代理的函数 (轮询)
function getChinaProxy() {
  if (loadedChinaProxies.length === 0) {
    return null; // 没有可用代理
  }
  const proxy = loadedChinaProxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % loadedChinaProxies.length;
  console.log(`[ProxyProvider] 提供国内代理: ${proxy}`);
  return proxy;
}
// --- 结束 国内代理缓存配置 ---

// 订阅类型
const SubscriptionType = {
  URL: 'url',
  BASE64: 'base64',
  VMESS: 'vmess',
  SS: 'ss',
  SSR: 'ssr',
  TROJAN: 'trojan'
};

// 目标转换格式
const ConversionFormat = {
  CLASH: 'clash',
  MIHOMO: 'mihomo',
  SURGE: 'surge',
  SINGBOX: 'singbox',
  V2RAY: 'v2ray'
};

// 测试配置
const TESTING_CONFIG = {
  enabled: true,
  concurrency: 5,
  timeout: 5000,
  test_url: "http://www.google.com/generate_204",
  filter_invalid: true,
  sort_by_latency: true,
  max_latency: 2000,
  max_nodes: 100,
  verify_location: false,
  ip_location: null
};

// 基本配置
const CONFIG = {
  rootDir: rootDir,
  configFile: path.resolve(rootDir, 'config/custom.yaml'),
  subscriptions: [],
  outputConfigs: [],
  options: {
    deduplication: true,
    dataDir: 'data',
    outputDir: 'output'
  },
  advanced: {
    logLevel: 'info',
    cacheTtl: 3600,
    proxyForSubscription: false,
    sortNodes: true,
    syncInterval: 360
  }
};

// 确保目录存在
function ensureDirectoryExists(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
    console.log(`创建目录: ${directory}`);
  }
}

// 从配置文件中读取订阅源和配置
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG.configFile)) {
      console.warn(`配置文件不存在: ${CONFIG.configFile}`);
      
      // 尝试在当前工作目录下查找
      const cwdConfigPath = path.resolve(process.cwd(), 'config/custom.yaml');
      console.log(`尝试在当前工作目录查找配置: ${cwdConfigPath}`);
      
      if (fs.existsSync(cwdConfigPath)) {
        CONFIG.configFile = cwdConfigPath;
        console.log(`找到配置文件: ${CONFIG.configFile}`);
      } else {
        return false;
      }
    }

    const content = fs.readFileSync(CONFIG.configFile, 'utf-8');
    const config = yaml.load(content);

    if (!config) {
      console.warn('配置文件内容为空');
      return false;
    }

    // 加载订阅源
    if (config.subscriptions && Array.isArray(config.subscriptions)) {
      CONFIG.subscriptions = config.subscriptions;
    } else if (typeof config.subscriptions === 'object') {
      // 处理对象格式的订阅源
      CONFIG.subscriptions = Object.entries(config.subscriptions).map(([key, sub]) => ({
        name: key,
        url: sub.url,
        enabled: sub.enabled !== false,
        type: 'url'
      }));
    } else {
      console.warn('配置文件中未找到有效的订阅源配置');
      CONFIG.subscriptions = [];
    }

    // 加载输出配置
    if (config.output) {
      if (config.output.deduplication !== undefined) {
        CONFIG.options.deduplication = config.output.deduplication;
      }
      
      if (config.output.dir) {
        CONFIG.options.outputDir = config.output.dir;
      }
      
      if (config.output.data_dir) {
        CONFIG.options.dataDir = config.output.data_dir;
      }
      
      if (config.output.configs && Array.isArray(config.output.configs)) {
        CONFIG.outputConfigs = config.output.configs;
      }
    }

    // 加载高级设置
    if (config.advanced) {
      if (config.advanced.log_level) {
        CONFIG.advanced.logLevel = config.advanced.log_level;
      }
      
      if (config.advanced.cache_ttl) {
        CONFIG.advanced.cacheTtl = config.advanced.cache_ttl;
      }
      
      if (config.advanced.proxy_for_subscription !== undefined) {
        CONFIG.advanced.proxyForSubscription = config.advanced.proxy_for_subscription;
      }
      
      if (config.advanced.sort_nodes !== undefined) {
        CONFIG.advanced.sortNodes = config.advanced.sort_nodes;
      }
      
      if (config.advanced.sync_interval) {
        CONFIG.advanced.syncInterval = config.advanced.sync_interval;
      }
    }

    // 加载测试配置
    if (config.testing) {
      TESTING_CONFIG.enabled = config.testing.enabled !== false;
      
      if (config.testing.concurrency) {
        TESTING_CONFIG.concurrency = config.testing.concurrency;
      }
      
      if (config.testing.timeout) {
        TESTING_CONFIG.timeout = config.testing.timeout;
      }
      
      if (config.testing.test_url) {
        TESTING_CONFIG.test_url = config.testing.test_url;
      }
      
      if (config.testing.filter_invalid !== undefined) {
        TESTING_CONFIG.filter_invalid = config.testing.filter_invalid;
      }
      
      if (config.testing.sort_by_latency !== undefined) {
        TESTING_CONFIG.sort_by_latency = config.testing.sort_by_latency;
      }
      
      if (config.testing.max_latency !== undefined) {
        TESTING_CONFIG.max_latency = config.testing.max_latency;
      }
      
      if (config.testing.max_nodes !== undefined) {
        TESTING_CONFIG.max_nodes = config.testing.max_nodes;
      }
      
      // 加载地区验证配置
      if (config.testing.verify_location !== undefined) {
        TESTING_CONFIG.verify_location = config.testing.verify_location;
      }
      
      // 加载IP地址定位配置
      if (config.testing.ip_location) {
        TESTING_CONFIG.ip_location = {
          api_url: config.testing.ip_location.api_url || 'https://ipinfo.io/{ip}/json',
          api_key: config.testing.ip_location.api_key || '',
          cache_time: config.testing.ip_location.cache_time || 604800000 // 默认7天
        };
      }
    }

    return CONFIG.subscriptions.length > 0;
  } catch (error) {
    console.error('解析配置文件失败:', error.message);
    return false;
  }
}

// 合并所有订阅节点
async function fetchAndMergeAllNodes(converter) {
  const allNodes = [];
  let successCount = 0;
  let failedCount = 0;
  
  console.log(`准备获取 ${CONFIG.subscriptions.length} 个订阅源的节点`);
  
  for (const subscription of CONFIG.subscriptions) {
    if (!subscription.enabled) {
      console.log(`跳过禁用的订阅: ${subscription.name}`);
      continue;
    }
    
    try {
      console.log(`===========================================================`);
      console.log(`开始处理订阅: ${subscription.name}, 类型: ${subscription.type || 'url'}, URL: ${subscription.url || '(BASE64/直接内容)'}`);
      
      let result;
      
      // 根据订阅类型处理
      if (subscription.type === SubscriptionType.BASE64 && subscription.content) {
        // 处理Base64内容
        console.log(`解析Base64订阅内容: ${subscription.name}`);
        result = await converter.parser.parse(subscription.content);
        console.log(`解析Base64订阅: ${subscription.name}, 获取 ${result.length} 个节点`);
      } else if ([SubscriptionType.VMESS, SubscriptionType.SS, SubscriptionType.SSR, SubscriptionType.TROJAN].includes(subscription.type) && subscription.content) {
        // 处理单个节点
        console.log(`解析单个${subscription.type}节点: ${subscription.name}`);
        const node = await converter.parser.parseLine(subscription.content);
        result = node ? [node] : [];
        console.log(`解析${subscription.type}节点: ${subscription.name}, 成功: ${result.length > 0}`);
      } else if (subscription.url) {
        // 获取URL订阅
        console.log(`从URL获取订阅: ${subscription.url}`);
        try {
          // 根据URL自定义请求头，部分订阅源需要特殊处理
          const customHeaders = {};
          const fetchOptions = { headers: customHeaders };
          
          // 为某些域名设置特殊请求头
          const url = new URL(subscription.url);
          const domain = url.hostname;
          
          // 为特定域名添加Referer和更多特定处理
          if (domain.includes('alalbb.top')) {
            console.log(`检测到alalbb.top域名，添加特定请求头`);
            customHeaders['Referer'] = 'https://alalbb.top/';
            customHeaders['Origin'] = 'https://alalbb.top';
            customHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
          } else if (domain.includes('flyi.me')) {
            console.log(`检测到flyi.me域名，添加特定请求头`);
            customHeaders['Referer'] = 'https://freesu7.flyi.me/';
            customHeaders['Origin'] = 'https://freesu7.flyi.me';
            customHeaders['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15';
          }
          
          console.log(`为 ${subscription.name} 设置的自定义请求头:`, customHeaders);
          
          // 直接使用fetcher获取数据，而不是通过convert方法
          console.log(`开始获取订阅内容...`);

          // *** 添加 requireChinaIP 选项 ***
          fetchOptions.requireChinaIP = subscription.requireChinaIP === true;
          if (fetchOptions.requireChinaIP) {
            console.log(`[Fetcher] 订阅 ${subscription.name} 已标记需要国内代理`);
          }

          const fetchResult = await converter.fetcher.fetch(subscription.url, fetchOptions);
          const rawData = fetchResult.data;
          
          console.log(`成功获取订阅: ${subscription.name}, 原始数据大小: ${rawData.length} 字节`);
          
          // 保存原始数据
          const dataDir = path.join(CONFIG.rootDir, CONFIG.options.dataDir);
          ensureDirectoryExists(dataDir);
          const rawFile = path.join(dataDir, `${subscription.name}.txt`);
          
          // 确保目录存在
          try {
            fs.writeFileSync(rawFile, rawData);
            console.log(`原始订阅数据已保存到: ${rawFile}`);
          } catch (writeError) {
            console.error(`保存原始订阅数据失败: ${writeError.message}`);
          }
          
          // 解析节点前尝试识别数据格式
          // 尝试识别常见的数据格式
          let detectedFormat = 'unknown';
          if (/^[A-Za-z0-9+/=]+$/.test(rawData.trim())) {
            detectedFormat = 'base64';
            console.log(`检测到Base64编码格式`);
          } else if (rawData.includes('proxies:')) {
            detectedFormat = 'clash';
            console.log(`检测到Clash格式`);
          } else if (rawData.includes('vmess://') || rawData.includes('ss://')) {
            detectedFormat = 'uri';
            console.log(`检测到URI格式`);
          } else if (rawData.startsWith('{') && rawData.endsWith('}')) {
            detectedFormat = 'json';
            console.log(`检测到JSON格式`);
          }
          console.log(`检测到的订阅格式: ${detectedFormat}`);
          
          // 解析节点
          console.log(`解析订阅数据...`);
          try {
            // 增加更详细的解析过程日志
            console.log(`开始使用订阅解析器解析数据`);
            result = await converter.parser.parse(rawData);
            console.log(`从 ${subscription.name} 解析出 ${result.length} 个节点`);
            
            // 输出解析结果的第一个节点以供调试
            if (result.length > 0) {
              console.log(`第一个节点示例:`, JSON.stringify(result[0], null, 2).substring(0, 200) + '...');
            }
          } catch (parseError) {
            console.error(`解析订阅数据时出错:`, parseError.message);
            console.error(`错误堆栈:`, parseError.stack);
            
            // 尝试使用备用解析方法
            console.log(`尝试使用备用解析方法...`);
            
            // 尝试作为Clash格式强制解析
            if (detectedFormat === 'clash' || rawData.includes('proxies:')) {
              console.log(`尝试强制作为Clash格式解析`);
              try {
                // 动态导入yaml解析库
                const yaml = await import('js-yaml');
                const clashConfig = yaml.load(rawData);
                
                if (clashConfig && clashConfig.proxies && Array.isArray(clashConfig.proxies)) {
                  console.log(`成功解析Clash配置，找到 ${clashConfig.proxies.length} 个代理节点`);
                  
                  // 手动转换节点
                  result = clashConfig.proxies.map(proxy => {
                    try {
                      return {
                        type: proxy.type,
                        name: proxy.name || '',
                        server: proxy.server || '',
                        port: parseInt(proxy.port) || 0,
                        settings: {
                          // VMess特殊处理
                          ...(proxy.type === 'vmess' && {
                            id: proxy.uuid || '',
                            alterId: proxy.alterId || 0,
                            security: proxy.cipher || 'auto',
                            network: proxy.network || 'tcp',
                            tls: proxy.tls === true,
                            wsPath: proxy['ws-path'] || (proxy['ws-opts'] && proxy['ws-opts'].path) || '',
                            wsHeaders: proxy['ws-headers'] || (proxy['ws-opts'] && proxy['ws-opts'].headers) || {}
                          }),
                          // SS特殊处理
                          ...(proxy.type === 'ss' && {
                            method: proxy.cipher || '',
                            password: proxy.password || ''
                          }),
                          // Trojan特殊处理
                          ...(proxy.type === 'trojan' && {
                            password: proxy.password || '',
                            sni: proxy.sni || '',
                            allowInsecure: proxy['skip-cert-verify'] === true
                          })
                        },
                        extra: {
                          raw: proxy
                        }
                      };
                    } catch (e) {
                      console.error(`转换Clash节点失败:`, e.message);
                      return null;
                    }
                  }).filter(Boolean);
                  
                  console.log(`成功转换 ${result.length} 个Clash节点`);
                } else {
                  console.log(`Clash配置解析失败或未找到有效的proxies字段`);
                }
              } catch (e) {
                console.error(`强制解析Clash失败:`, e.message);
              }
            }
            
            // 如果仍然没有结果，记录错误
            if (!result || result.length === 0) {
              console.error(`所有解析方法都失败，无法解析订阅数据`);
            }
          }
          
          if (!result || result.length === 0) {
            console.warn(`解析结果为空，尝试查看原始数据的前200个字符:`);
            console.warn(rawData.substring(0, 200));
            
            // 保存到失败记录
            const errorFile = path.join(dataDir, `${subscription.name}_error.txt`);
            try {
              fs.writeFileSync(errorFile, `时间: ${new Date().toISOString()}\n格式: ${detectedFormat}\n内容:\n${rawData}`);
              console.log(`已保存解析失败的内容到: ${errorFile}`);
            } catch (e) {
              console.error(`保存错误内容失败: ${e.message}`);
            }
          }
        } catch (fetchError) {
          console.error(`获取订阅 ${subscription.url} 时出错:`, fetchError);
          console.error(`错误堆栈:`, fetchError.stack);
          failedCount++;
          continue; // 继续处理下一个订阅
        }
      }
      
      if (result && result.length > 0) {
        console.log(`从 ${subscription.name} 获取到 ${result.length} 个节点`);
        
        // 添加订阅源信息
        result.forEach(node => {
          if (!node.extra) node.extra = {};
          node.extra.source = subscription.name;
        });
        
        allNodes.push(...result);
        successCount++;
      } else {
        console.warn(`从 ${subscription.name} 未获取到任何节点`);
        failedCount++;
      }
    } catch (error) {
      console.error(`处理订阅 ${subscription.name} 时出错:`, error.message);
      console.error(`错误堆栈:`, error.stack);
      failedCount++;
    }
    
    console.log(`===========================================================`);
  }
  
  console.log(`订阅获取统计: 成功 ${successCount} 个, 失败 ${failedCount} 个, 总共获取 ${allNodes.length} 个节点`);
  
  // 如果启用去重，进行节点去重
  let finalNodes = allNodes;
  if (CONFIG.options.deduplication && allNodes.length > 0) {
    console.log(`正在进行节点去重...`);
    finalNodes = converter.deduplicator.deduplicate(allNodes);
    console.log(`节点去重: ${allNodes.length} -> ${finalNodes.length}`);
  }
  
  // 对节点进行分析和重命名
  if (finalNodes.length > 0) {
    console.log(`正在对节点进行分析和重命名...`);
    // 使用nodeManager处理节点
    const processedResult = converter.nodeManager.processNodes(finalNodes);
    finalNodes = processedResult.nodes;
    
    // 重命名节点
    finalNodes = converter.nodeManager.renameNodes(finalNodes, {
      format: '{country}{protocol}{tags}{number}',
      includeCountry: true,
      includeProtocol: true,
      includeNumber: true,
      includeTags: true,
      tagLimit: 2
    });
    
    console.log(`完成节点分析和重命名，节点数量: ${finalNodes.length}`);
  }
  
  // 如果没有获取到任何节点，尝试使用备用节点
  if (finalNodes.length === 0) {
    console.warn(`未获取到任何节点，尝试使用备用示例节点...`);
    try {
      // 创建一些示例节点，以便在测试环境中工作
      const backupNodes = [
        {
          type: 'ss',
          name: '备用节点1 (自动生成)',
          server: '127.0.0.1',
          port: 8388,
          settings: {
            method: 'aes-256-gcm',
            password: 'password123'
          },
          extra: {
            source: '备用节点',
            notes: '这是由系统自动生成的备用节点，用于在无法获取任何订阅时保持功能正常运行'
          }
        },
        {
          type: 'vmess',
          name: '备用节点2 (自动生成)',
          server: '127.0.0.1',
          port: 443,
          settings: {
            id: '00000000-0000-0000-0000-000000000000',
            security: 'auto',
            alterId: 0
          },
          extra: {
            source: '备用节点',
            notes: '这是由系统自动生成的备用节点，用于在无法获取任何订阅时保持功能正常运行'
          }
        }
      ];
      
      finalNodes = backupNodes;
      console.log(`已添加 ${backupNodes.length} 个备用节点`);
    } catch (e) {
      console.error(`创建备用节点失败:`, e.message);
    }
  }
  
  return finalNodes;
}

/**
 * 测试节点有效性和延迟
 * @param {Array} nodes 节点列表
 * @param {Object} testConfig 测试配置
 * @returns {Promise<Object>} 包含测试结果和tester实例的对象
 */
async function testNodes(nodes, testConfig) {
  // 如果测试功能禁用，返回空结果
  if (!testConfig.enabled) {
    return { results: [], tester: null };
  }

  console.log(`开始测试 ${nodes.length} 个节点的连通性和延迟...`);
  console.log(`测试配置: 并发=${testConfig.concurrency}, 超时=${testConfig.timeout}ms, URL=${testConfig.test_url}`);

  try {
    // 创建测试器实例
    const tester = new NodeTester({
      concurrency: testConfig.concurrency,
      timeout: testConfig.timeout,
      testUrl: testConfig.test_url,
      verifyLocation: testConfig.verify_location !== false,
      ipLocatorOptions: {
        apiUrl: testConfig.ip_location?.api_url,
        apiKey: testConfig.ip_location?.api_key,
        cacheTime: testConfig.ip_location?.cache_time
      }
    });
    
    // 开始测试
    const testResults = await tester.testNodes(nodes);
    // 返回测试结果和测试器实例
    return { results: testResults, tester };
  } catch (error) {
    console.error('节点测试过程出错:', error.message);
    console.error('错误堆栈:', error.stack);
    // 测试失败时返回空结果
    return { results: [], tester: null };
  }
}

/**
 * 生成各种配置文件
 * @param {Array} nodes 所有节点
 * @param {Object} outputConfigs 输出配置
 * @param {Object} options 全局选项
 */
// generateConfigs function removed as requested.

/**
 * 将分组节点直接输出到对应文件而非使用base64编码
 * @param {Array} nodes 所有节点
 * @param {Object} options 全局选项
 */
async function generateGroupedNodeFiles(nodes, options) {
  const rootDir = options.rootDir || process.cwd();
  const outputDir = path.join(rootDir, options.outputDir || 'output');
  ensureDirectoryExists(outputDir);
  
  console.log(`准备生成分组节点文件...`);
  
  if (nodes.length === 0) {
    console.warn('没有节点数据，无法生成分组节点文件');
    return;
  }

  try {
    // 创建分组管理器
    const { GroupManager } = await import('../converter/analyzer/GroupManager.js');
    const groupManager = new GroupManager();
    const { groups } = groupManager.groupNodes(nodes);

    // 创建分组目录
    const groupDir = path.join(outputDir, 'groups');
    ensureDirectoryExists(groupDir);
    
    console.log(`分组目录: ${groupDir}`);
    console.log(`分组目录完整路径: ${path.resolve(groupDir)}`);
    
    // 检查目录权限
    try {
      fs.accessSync(groupDir, fs.constants.W_OK);
      console.log(`分组目录有写入权限`);
    } catch (err) {
      console.error(`分组目录没有写入权限: ${err.message}`);
      // 尝试修改权限
      try {
        fs.chmodSync(groupDir, 0o755);
        console.log(`已尝试修改分组目录权限`);
      } catch (chmodErr) {
        console.error(`修改目录权限失败: ${chmodErr.message}`);
      }
    }
    
    // 处理地区分组
    let generatedFiles = 0;
    
    if (groups.region && groups.region.length > 0) {
      console.log(`发现 ${groups.region.length} 个地区分组`);
      
      for (const group of groups.region) {
        if (group.nodes.length > 0) {
          // 如果是 '其他' 分组，则跳过，避免生成重复的 output/groups/Others.txt
          if (group.name === '其他') {
            console.log(`跳过生成 '其他' 分组文件 (output/groups/Others.txt)，因为它与 output/others.txt 重复。`);
            continue;
          }
          
          // 使用英文文件名
          let filename;
          if (group.name === '香港') filename = 'HK.txt';
          else if (group.name === '台湾') filename = 'TW.txt';
          else if (group.name === '新加坡') filename = 'SG.txt';
          else if (group.name === '美国') filename = 'US.txt';
          else if (group.name === '日本') filename = 'JP.txt';
          else if (group.name === '其他') filename = 'Others.txt';
          else filename = `${group.name}.txt`;
          
          const outputPath = path.join(groupDir, filename);
          
          // 将节点原始链接拼接为字符串
          const rawNodes = group.nodes
                  .map(node => {
              // 优先使用原始URI
              // 增加类型检查，确保 node.extra.raw 是字符串
              if (node.extra?.raw && typeof node.extra.raw === 'string' && node.extra.raw.trim().length > 0) {
                console.log(`节点 ${node.name} 使用原始URI: ${node.extra.raw.substring(0, 30)}...`);
                return node.extra.raw;
              }
              
              // 构造节点名称，遵循分组格式
              // 获取国家/地区前缀
              let prefix = '';
              if (group.name === '香港') prefix = '🇭🇰 香港 ';
              else if (group.name === '台湾') prefix = '🇹🇼 台湾 ';
              else if (group.name === '新加坡') prefix = '🇸🇬 新加坡 ';
              else if (group.name === '美国') prefix = '🇺🇸 美国 ';
              else if (group.name === '日本') prefix = '🇯🇵 日本 ';
              else if (group.name === '其他') prefix = '🌍 其他 ';
              else prefix = '';
              
              // 构造完整节点名称
              const nodeName = node.name.includes(group.name) ? node.name : `${prefix}${node.name}`;
              console.log(`为节点 ${node.name} 构造URI，修正名称为: ${nodeName}`);
              
              // 如果没有原始URI，尝试根据节点属性构造
              if (node.type === 'vmess' && node.settings?.id) {
                // 构造VMess节点URI
                const vmessInfo = {
                  v: "2",
                  ps: nodeName,
                  add: node.server,
                  port: parseInt(node.port) || 443,
                  id: node.settings.id,
                  aid: parseInt(node.settings.alterId) || 0,
                  net: node.settings.network || "tcp",
                  type: "none",
                  host: (node.settings.wsHeaders && node.settings.wsHeaders.Host) || "",
                  path: node.settings.wsPath || "/",
                  tls: node.settings.tls ? "tls" : "none"
                };
                const vmessUri = `vmess://${Buffer.from(JSON.stringify(vmessInfo)).toString('base64')}`;
                console.log(`已构造VMess节点URI: ${vmessUri.substring(0, 30)}...`);
                return vmessUri;
              } else if (node.type === 'ss' && node.settings?.method && node.settings?.password) {
                // 构造Shadowsocks节点URI
                const userInfo = `${node.settings.method}:${node.settings.password}`;
                const base64UserInfo = Buffer.from(userInfo).toString('base64');
                const ssUri = `ss://${base64UserInfo}@${node.server}:${parseInt(node.port) || 443}#${encodeURIComponent(nodeName)}`;
                console.log(`已构造SS节点URI: ${ssUri.substring(0, 30)}...`);
                return ssUri;
              } else if (node.type === 'trojan' && node.settings?.password) {
                // 构造Trojan节点URI
                const trojanUri = `trojan://${node.settings.password}@${node.server}:${parseInt(node.port) || 443}?sni=${node.settings.sni || ''}&allowInsecure=${node.settings.allowInsecure ? '1' : '0'}#${encodeURIComponent(nodeName)}`;
                console.log(`已构造Trojan节点URI: ${trojanUri.substring(0, 30)}...`);
                return trojanUri;
              } else if (node.type === 'ssr' && node.settings) {
                // 构造SSR节点URI
                try {
                  const ssrParams = {
                          server: node.server,
                    port: parseInt(node.port) || 443,
                    protocol: node.settings.protocol || 'origin',
                    method: node.settings.method || 'aes-256-cfb',
                    obfs: node.settings.obfs || 'plain',
                    password: node.settings.password || '',
                  };
                  
                  const base64Params = Buffer.from(
                    `${ssrParams.server}:${ssrParams.port}:${ssrParams.protocol}:${ssrParams.method}:${ssrParams.obfs}:${Buffer.from(ssrParams.password).toString('base64')}`
                  ).toString('base64');
                  
                  const base64Remarks = Buffer.from(nodeName).toString('base64');
                  const ssrUri = `ssr://${base64Params}/?remarks=${base64Remarks}`;
                  console.log(`已构造SSR节点URI: ${ssrUri.substring(0, 30)}...`);
                  return ssrUri;
                } catch (error) {
                  console.error(`构造SSR节点URI失败:`, error);
                  return '';
                }
              }
              
              // 无法构造URI的情况下返回空字符串
              console.warn(`无法为节点 ${node.name} 构造URI，类型: ${node.type}`);
              return '';
            })
            .filter(raw => raw.trim().length > 0) // 过滤掉空链接
            .join('\n'); // 用换行符连接
          
          // 输出节点数量统计
          const uriCount = rawNodes.split('\n').length;
          console.log(`${filename} 生成了 ${uriCount} 个节点URI，原始节点数 ${group.nodes.length}`);
          
          // 直接写入原始节点链接，不再使用base64编码
          try {
            fs.writeFileSync(outputPath, rawNodes);
            console.log(`已生成地区分组节点文件: ${filename} (${group.nodes.length} 个节点)`);
            console.log(`文件完整路径: ${path.resolve(outputPath)}`);
            generatedFiles++;
          } catch (writeErr) {
            console.error(`写入文件失败: ${filename} - ${writeErr.message}`);
          }
        }
      }
    }
    
    // 处理应用/流媒体分组
    if (groups.media && groups.media.length > 0) {
      console.log(`发现 ${groups.media.length} 个应用/流媒体分组`);

      for (const group of groups.media) {
        if (group.nodes.length > 0) {
          // 使用分组名称作为文件名，例如 OpenAI.txt, Disney+.txt
          // 需要处理 '+' 等可能在文件名中不安全的字符
          const safeGroupName = group.name.replace(/[^a-zA-Z0-9_-]/g, '_'); // 替换特殊字符为下划线
          const filename = `${safeGroupName}.txt`;
          const outputPath = path.join(groupDir, filename);

          // 将节点原始链接拼接为字符串 (与地区分组逻辑相同)
          const rawNodes = group.nodes
            .map(node => {
              if (node.extra?.raw && typeof node.extra.raw === 'string' && node.extra.raw.trim().length > 0) {
                return node.extra.raw;
              }
              // 构造节点名称
              const nodeName = node.name || 'Unnamed Node';
              // 尝试构造URI (省略具体构造逻辑，与地区分组相同)
              if (node.type === 'vmess' && node.settings?.id) {
                const vmessInfo = { v: "2", ps: nodeName, add: node.server, port: parseInt(node.port) || 443, id: node.settings.id, aid: parseInt(node.settings.alterId) || 0, net: node.settings.network || "tcp", type: "none", host: (node.settings.wsHeaders && node.settings.wsHeaders.Host) || "", path: node.settings.wsPath || "/", tls: node.settings.tls ? "tls" : "none" };
                return `vmess://${Buffer.from(JSON.stringify(vmessInfo)).toString('base64')}`;
              } else if (node.type === 'ss' && node.settings?.method && node.settings?.password) {
                const userInfo = `${node.settings.method}:${node.settings.password}`;
                const base64UserInfo = Buffer.from(userInfo).toString('base64');
                return `ss://${base64UserInfo}@${node.server}:${parseInt(node.port) || 443}#${encodeURIComponent(nodeName)}`;
              } else if (node.type === 'trojan' && node.settings?.password) {
                return `trojan://${node.settings.password}@${node.server}:${parseInt(node.port) || 443}?sni=${node.settings.sni || ''}&allowInsecure=${node.settings.allowInsecure ? '1' : '0'}#${encodeURIComponent(nodeName)}`;
              } else if (node.type === 'ssr' && node.settings) {
                try {
                  const ssrParams = { server: node.server, port: parseInt(node.port) || 443, protocol: node.settings.protocol || 'origin', method: node.settings.method || 'aes-256-cfb', obfs: node.settings.obfs || 'plain', password: node.settings.password || '' };
                  const base64Params = Buffer.from(`${ssrParams.server}:${ssrParams.port}:${ssrParams.protocol}:${ssrParams.method}:${ssrParams.obfs}:${Buffer.from(ssrParams.password).toString('base64')}`).toString('base64');
                  const base64Remarks = Buffer.from(nodeName).toString('base64');
                  return `ssr://${base64Params}/?remarks=${base64Remarks}`;
                } catch (error) { return ''; }
              }
              console.warn(`无法为应用分组节点 ${node.name} 构造URI，类型: ${node.type}`);
              return '';
            })
            .filter(raw => raw && raw.trim().length > 0)
            .join('\n');

          const uriCount = rawNodes.split('\n').filter(Boolean).length; // 确保计算准确
          console.log(`${filename} 生成了 ${uriCount} 个节点URI，原始节点数 ${group.nodes.length}`);

          // 写入文件
          try {
            fs.writeFileSync(outputPath, rawNodes);
            console.log(`已生成应用/流媒体分组节点文件: ${filename} (${group.nodes.length} 个节点)`);
            console.log(`文件完整路径: ${path.resolve(outputPath)}`);
            generatedFiles++; // 增加计数器
          } catch (writeErr) {
            console.error(`写入文件失败: ${filename} - ${writeErr.message}`);
          }
        }
      }
    }
    
    const message = `分组节点文件生成完成，共生成 ${generatedFiles} 个文件`;
    console.log(message);
    
    // 触发转换完成事件，发送Bark通知
    eventEmitter.emit(EventType.CONVERSION_COMPLETE, {
      nodeCount: nodes.length,
      time: Date.now(),
      message: message
    });
  } catch (error) {
    console.error(`生成分组节点文件时出错:`, error);
    console.error(`错误堆栈: ${error.stack}`);
    
    // 触发错误事件，通过Bark通知
    eventEmitter.emit(EventType.SYSTEM_ERROR, {
      message: `生成分组节点文件出错: ${error.message}`,
      error: error
    });
  }
}

// 主函数
async function main() {
  console.log('==================================================================');
  console.log(`开始同步订阅...时间: ${new Date().toISOString()}`);
  console.log('==================================================================');
// *** 加载国内代理缓存 ***
  loadedChinaProxies = loadChinaProxies();
  
  let previousNodeCount = null; // 初始化上次节点数
  const dataDir = path.join(CONFIG.rootDir, CONFIG.options.dataDir);
  const statusFile = path.join(dataDir, 'sync_status.json');

  try {
    // 尝试读取上次同步状态
    if (fs.existsSync(statusFile)) {
      const statusContent = fs.readFileSync(statusFile, 'utf-8');
      const lastStatus = JSON.parse(statusContent);
      if (lastStatus && typeof lastStatus.finalNodesCount === 'number') {
        previousNodeCount = lastStatus.finalNodesCount;
        console.log(`读取到上次同步节点数: ${previousNodeCount}`);
      }
    }
  } catch (e) {
    console.warn(`读取上次同步状态文件失败: ${e.message}`);
  }

  try {
    // 加载配置
    if (!loadConfig()) {
      console.error('配置加载失败，请检查配置文件是否存在且格式正确');
      return;
    }
    
    console.log(`发现 ${CONFIG.subscriptions.length} 个订阅源`);
    console.log(`启用的订阅源: ${CONFIG.subscriptions.filter(sub => sub.enabled).length} 个`);
    console.log(`当前配置: 去重=${CONFIG.options.deduplication}, 数据目录=${CONFIG.options.dataDir}, 输出目录=${CONFIG.options.outputDir}`);
    console.log(`测试配置: 启用=${TESTING_CONFIG.enabled}, 超时=${TESTING_CONFIG.timeout}ms, 并发=${TESTING_CONFIG.concurrency}`);
    
    // 添加输出配置的详细日志
    console.log(`输出配置详情: ${JSON.stringify(CONFIG.outputConfigs, null, 2)}`);
    console.log(`输出配置数量: ${CONFIG.outputConfigs.length}`);
    console.log(`是否有启用的输出配置: ${CONFIG.outputConfigs.some(cfg => cfg.enabled !== false)}`);

    // 初始化通知系统
    const barkUrl = process.env.BARK_URL;
    if (barkUrl) {
      console.log(`Bark通知已启用: ${barkUrl}`);
      const barkNotifier = new BarkNotifier({
        barkUrl: barkUrl,
        title: process.env.BARK_TITLE || 'SubSyncForge',
        events: [
          EventType.CONVERSION_COMPLETE,
          EventType.SYSTEM_ERROR, 
          EventType.SYSTEM_WARNING
        ]
      });
      
      // 确保通知系统正确注册
      barkNotifier.registerEventListeners(eventEmitter);
      
      // 不再发送测试事件
      console.log('Bark通知系统已初始化');
      
                } else {
      console.log('Bark通知未启用，可通过设置BARK_URL环境变量启用');
    }

    // 如果没有可用的订阅源，添加一个备用订阅
    if (CONFIG.subscriptions.length === 0 || CONFIG.subscriptions.every(sub => !sub.enabled)) {
      console.log('未找到启用的订阅源，添加一个测试订阅源');
      
      // 添加一个备用订阅源
      CONFIG.subscriptions.push({
        name: "测试订阅源",
        url: "https://api.v1.mk/sub?target=clash&url=https%3A%2F%2Fghproxy.com%2Fhttps%3A%2F%2Fraw.githubusercontent.com%2Fmkht%2Ffree-node%2Fmain%2Fbase64",
        enabled: true
      });
      
      console.log('添加测试订阅源完成');
    }

    // 创建输出目录
    const outputDir = path.join(CONFIG.rootDir, CONFIG.options.outputDir);
    ensureDirectoryExists(outputDir);
    console.log(`确保输出目录存在: ${outputDir}`);
    
    // 创建数据目录
    const dataDir = path.join(CONFIG.rootDir, CONFIG.options.dataDir);
    ensureDirectoryExists(dataDir);
    console.log(`确保数据目录存在: ${dataDir}`);

    // 创建转换器实例
    console.log('初始化订阅转换器...');
    const converter = new SubscriptionConverter({
      dedup: CONFIG.options.deduplication,
      validateInput: true,
      validateOutput: true,
      recordMetrics: true,
      emitEvents: true,
      nodeManagement: CONFIG.advanced.sortNodes,
      renameNodes: true,
      renameFormat: '{country}{protocol}{tags}{number}',
      groupingMode: 'advanced',
      applyRules: true,
      fetch: {
        timeout: 60000,  // 增加超时时间到60秒
        maxRetries: 3,   // 每个UA尝试3次
        userAgent: 'v2rayN/5.29', // 使用v2rayN作为UA
        chinaProxyProvider: getChinaProxy // *** 传递代理提供者 ***
      }
    });
    
    console.log('订阅转换器初始化完成');
    
    // 1. 获取并合并所有节点
    console.log('开始获取并合并所有节点...');
    const fetchStartTime = Date.now();
    const rawNodes = await fetchAndMergeAllNodes(converter);
    const fetchTime = Date.now() - fetchStartTime;
    console.log(`获取节点完成，耗时: ${fetchTime}ms`);
    
    if (rawNodes.length === 0) {
      console.warn('未获取到任何有效节点，但会继续尝试生成过程');
    }
    
    console.log(`共获取 ${rawNodes.length} 个有效节点`);
    
    // 保存所有原始节点数据
    try {
      const rawNodesFile = path.join(dataDir, 'raw_nodes.json');
      fs.writeFileSync(rawNodesFile, JSON.stringify(rawNodes, null, 2));
      console.log(`已保存原始节点数据到: ${rawNodesFile}`);
    } catch (e) {
      console.error('保存原始节点数据失败:', e.message);
    }
    
    // 2. 测试节点有效性和延迟
    console.log('开始测试节点连通性和延迟...');
    const testStartTime = Date.now();
    // 从testNodes函数获取测试结果和tester实例
    const { results: testResults, tester } = await testNodes(rawNodes, TESTING_CONFIG);
    const testTime = Date.now() - testStartTime;
    
    // 根据测试结果处理节点
    let finalNodes = rawNodes;
    
    if (TESTING_CONFIG.enabled) {
      if (TESTING_CONFIG.filter_invalid) {
        // 只保留连通性测试通过的节点
        const validResults = testResults.filter(r => r.status === 'up');
        console.log(`测试结果: 有效节点 ${validResults.length}/${rawNodes.length} (${(validResults.length/rawNodes.length*100).toFixed(1)}%), 无效节点 ${testResults.length - validResults.length}`);
        
        // 检查是否启用地区验证，并进行节点名称修正
        if (TESTING_CONFIG.verify_location !== false && tester) { // 确保tester存在
          console.log(`开始验证节点地区信息...`);
          // 取出有效节点
          const nodesToCorrect = validResults.map(r => r.node);
          // 使用节点测试器的correctNodeLocations方法修正地区信息
          const correctedNodes = tester.correctNodeLocations(nodesToCorrect, validResults);
          // 使用修正后的节点替换
          validResults.forEach((result, index) => {
            if (nodesToCorrect[index] !== correctedNodes[index]) {
              // 替换节点对象
              result.node = correctedNodes[index];
            }
          });
          console.log(`节点地区验证完成`);
        }
        
        // 按延迟排序
        if (TESTING_CONFIG.sort_by_latency && validResults.length > 0) {
          validResults.sort((a, b) => (a.latency || 99999) - (b.latency || 99999));
          
          // 输出延迟统计
          const latencies = validResults.map(n => n.latency).filter(Boolean);
          if (latencies.length > 0) {
            const avgLatency = latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length;
            const minLatency = Math.min(...latencies);
            const maxLatency = Math.max(...latencies);
            
            console.log(`延迟统计: 最小=${minLatency}ms, 最大=${maxLatency}ms, 平均=${avgLatency.toFixed(0)}ms`);
            console.log(`最快的5个节点:`)
            validResults.slice(0, 5).forEach((result, idx) => {
              console.log(`  ${idx+1}. ${result.node.name}: ${result.latency}ms`);
            });
          }
        }
        
        // 按最大延迟过滤
        let filteredResults = validResults;
        if (TESTING_CONFIG.max_latency > 0) {
          const beforeCount = filteredResults.length;
          filteredResults = filteredResults.filter(r => r.latency && r.latency <= TESTING_CONFIG.max_latency);
          console.log(`按最大延迟(${TESTING_CONFIG.max_latency}ms)过滤: ${beforeCount} -> ${filteredResults.length}`);
        }
        
        // 按最大节点数量限制
        if (TESTING_CONFIG.max_nodes > 0 && filteredResults.length > TESTING_CONFIG.max_nodes) {
          filteredResults = filteredResults.slice(0, TESTING_CONFIG.max_nodes);
          console.log(`按最大节点数量(${TESTING_CONFIG.max_nodes})限制: ${filteredResults.length}`);
        }
        
        // 仅保留有效节点
        finalNodes = filteredResults.map(r => r.node);
      } else {
        // 所有节点都保留的情况，同样需要修正地区
        if (TESTING_CONFIG.verify_location !== false && tester) { // 确保tester存在
          console.log(`开始验证节点地区信息...`);
          // 取出所有节点
          finalNodes = tester.correctNodeLocations(finalNodes, testResults);
          console.log(`节点地区验证完成`);
        }
        
        // 所有节点都保留，但添加测试结果到节点的extra字段中
        finalNodes = rawNodes.map(node => {
          const result = testResults.find(r => r.node === node);
          if (result) {
            const nodeWithTestResult = { ...node };
            if (!nodeWithTestResult.extra) nodeWithTestResult.extra = {};
            nodeWithTestResult.extra.test = {
              status: result.status,
              latency: result.latency,
              timestamp: new Date().toISOString()
            };
            return nodeWithTestResult;
          }
          return node;
        });
        
        // 添加测试结果标记
        finalNodes.forEach(node => {
          if (node.extra?.test?.status === 'up') {
            if (node.name && !node.name.includes('✓')) {
              node.name = `✓ ${node.name}`;
            }
            
            if (node.extra?.test?.latency) {
              // 为名称添加延迟标记（如果没有）
              if (node.name && !node.name.includes('ms')) {
                node.name = `${node.name} [${node.extra.test.latency}ms]`;
              }
            }
          } else if (node.extra?.test?.status === 'down') {
            if (node.name && !node.name.includes('✗')) {
              node.name = `✗ ${node.name}`;
            }
          }
        });
        
        // 即使保留所有节点，也可以按测试结果排序
        if (TESTING_CONFIG.sort_by_latency) {
          finalNodes.sort((a, b) => {
            // 有效节点在前
            if (a.extra?.test?.status === 'up' && b.extra?.test?.status !== 'up') return -1;
            if (a.extra?.test?.status !== 'up' && b.extra?.test?.status === 'up') return 1;
            
            // 两个都有效，按延迟排序
            if (a.extra?.test?.status === 'up' && b.extra?.test?.status === 'up') {
              return (a.extra?.test?.latency || 99999) - (b.extra?.test?.latency || 99999);
            }
            
            return 0;
          });
        }
      }
      
      console.log(`节点测试完成，耗时: ${testTime}ms, 最终保留节点数: ${finalNodes.length}`);
      
      // 保存测试报告
      try {
        const reportFile = path.join(dataDir, 'test_report.json');
        const reportData = {
          timestamp: new Date().toISOString(),
          tested: rawNodes.length,
          valid: testResults.filter(r => r.status === 'up').length,
          invalid: testResults.filter(r => r.status === 'down').length,
          filtered: finalNodes.length,
          testTime,
          results: testResults.map(r => ({
            name: r.node.name,
            server: r.node.server,
            type: r.node.type,
            status: r.status,
            latency: r.latency,
            error: r.error
          }))
        };
        
        fs.writeFileSync(reportFile, JSON.stringify(reportData, null, 2));
        console.log(`测试报告已保存至: ${reportFile}`);
      } catch (e) {
        console.error('保存测试报告失败:', e.message);
                }
              } else {
      console.log('节点测试功能已禁用，跳过测试');
    }
    
    // 保存最终节点数据
    try {
      const finalNodesFile = path.join(dataDir, 'final_nodes.json');
      fs.writeFileSync(finalNodesFile, JSON.stringify(finalNodes, null, 2));
      console.log(`已保存最终节点数据到: ${finalNodesFile}`);
    } catch (e) {
      console.error('保存最终节点数据失败:', e.message);
    }
    
    // 过滤掉中国节点
    const filteredNodesCount = finalNodes.length;
    finalNodes = finalNodes.filter(node => {
      // 根据countryCode过滤
      if (node.analysis && node.analysis.countryCode === 'CN') {
        return false;
      }
      // 根据country过滤
      if (node.analysis && node.analysis.country === '中国') {
        return false;
      }
      // 根据节点名称过滤包含中国、CN的节点
      const name = (node.name || '').toUpperCase();
      if (name.includes('中国') || name.includes('CN') || name.includes('CHINA') || 
          name.includes('国内') || name.includes('大陆')) {
        return false;
      }
      return true;
    });
    console.log(`过滤中国节点: ${filteredNodesCount} -> ${finalNodes.length}, 移除了 ${filteredNodesCount - finalNodes.length} 个节点`);
    
    // 输出节点国家/地区分布情况
    try {
      const countryCount = {};
      finalNodes.forEach(node => {
        const country = node.country || 'Unknown';
        countryCount[country] = (countryCount[country] || 0) + 1;
      });
      
      console.log('节点国家/地区分布:');
      Object.entries(countryCount)
        .sort((a, b) => b[1] - a[1])
        .forEach(([country, count]) => {
          console.log(`  ${country}: ${count} 个节点`);
        });
    } catch (e) {
      console.error('统计节点国家分布出错:', e.message);
    }
    
    // 3. 生成分组节点文件 (原步骤4)
    console.log('开始生成分组节点文件...');
    const groupStartTime = Date.now();
    await generateGroupedNodeFiles(finalNodes, CONFIG.options);
    const groupTime = Date.now() - groupStartTime;
    console.log(`生成分组节点文件完成，耗时: ${groupTime}ms`);

    // 生成一个状态文件，记录同步时间和结果
    try {
      const statusFile = path.join(dataDir, 'sync_status.json');
      const statusData = {
        lastSync: new Date().toISOString(),
        originalNodesCount: rawNodes.length,
        testedNodesCount: TESTING_CONFIG.enabled ? testResults.filter(r => r.status === 'up').length : 0,
        finalNodesCount: finalNodes.length,
        successSubscriptions: CONFIG.subscriptions.filter(sub => sub.enabled).length,
        outputConfigs: CONFIG.outputConfigs.length,
        fetchTime,
        testTime: TESTING_CONFIG.enabled ? testTime : 0,
        genTime,
        totalTime: fetchTime + (TESTING_CONFIG.enabled ? testTime : 0) + genTime
      };
      
      fs.writeFileSync(statusFile, JSON.stringify(statusData, null, 2));
      console.log(`已保存同步状态到: ${statusFile}`);
    } catch (e) {
      console.error('保存同步状态失败:', e.message);
    }
    
    // 编译节点统计数据
    let totalNodes = 0;
    const protocols = {};
    const providers = [];
    const regionsCount = {};
    
    if (finalNodes && Array.isArray(finalNodes)) {
      totalNodes = finalNodes.length;
      
      // 统计协议
      for (const node of finalNodes) {
        if (node.protocol) {
          protocols[node.protocol] = (protocols[node.protocol] || 0) + 1;
        }
        
        // 统计地区
        if (node.analysis && node.analysis.country) {
          const country = node.analysis.country;
          regionsCount[country] = (regionsCount[country] || 0) + 1;
        }
      }
      
      // 收集提供商
      if (CONFIG.subscriptions) {
        CONFIG.subscriptions.forEach(sub => {
          if (sub.enabled && sub.name) {
            providers.push(sub.name);
          }
        });
      }
    }
    
    // 发送完成通知
    // 在处理完所有节点后发送更详细的通知
    try {
      console.log('发送完成通知事件...');
      const eventData = {
        nodeCount: totalNodes,
        previousNodeCount: previousNodeCount, // 添加上次节点数
        time: Date.now() - fetchStartTime,
        protocols: protocols,
        providers: providers,
        regionsCount: regionsCount
      };
      console.log(`通知事件数据: ${JSON.stringify(eventData)}`);
      
      eventEmitter.emit(EventType.CONVERSION_COMPLETE, eventData);
      console.log('完成通知事件已触发');
    } catch (error) {
      console.error('发送通知事件时出错:', error);
      console.error('错误堆栈:', error.stack);
    }
// *** 提取并保存本次运行找到的国内代理供下次使用 ***
    console.log('[Main] 提取并保存国内 HTTP/HTTPS/SOCKS5 代理...'); // 更新日志信息
    const currentChinaProxies = [];
    // 使用 finalNodes，因为它包含了测试和过滤后的最终节点列表
console.log('[Debug] Final nodes before caching check:', JSON.stringify(finalNodes.filter(n => n.type === 'http' || n.type === 'https' || n.type === 'socks' || n.type === 'socks5'), null, 2)); // 打印所有潜在的代理节点
    for (const node of finalNodes) {
      // !! 重要: 确认国家代码和代理类型判断逻辑是否符合你的节点结构 !!
      // 检查节点分析结果中的国家信息
      const isChinaNode = (node.analysis && node.analysis.country === '中国') ||
                          (node.extra?.location?.country_code === 'CN') ||
                          (node.extra?.location?.country && /中国|china/i.test(node.extra.location.country)) ||
                          (node.name && /CN|中国|中转|国内|回国/i.test(node.name)); // 补充检查节点名称和原始位置信息

      const isSupportedProxyType = ['http', 'https', 'socks', 'socks5'].includes(node.type); // 支持的代理类型

      if (isChinaNode && isSupportedProxyType) {
         // 构建代理 URL，考虑认证信息
         // !! 重要: 确认认证信息存储位置 !!
         let protocol = node.type === 'socks' ? 'socks5' : node.type; // 将 'socks' 视为 'socks5'
         let proxyUrl = `${protocol}://`;
         // SOCKS5 和 HTTP/HTTPS 可能有认证
         if (node.settings && node.settings.username && node.settings.password) {
           proxyUrl += `${encodeURIComponent(node.settings.username)}:${encodeURIComponent(node.settings.password)}@`;
         }
         proxyUrl += `${node.server}:${node.port}`;
         currentChinaProxies.push(proxyUrl);
      }
    }
    console.log(`[Main] 本次运行找到 ${currentChinaProxies.length} 个国内 HTTP/HTTPS/SOCKS5 代理`); // 更新日志信息
    saveChinaProxies(currentChinaProxies); // 保存供下次使用
    
    console.log('==================================================================');
    console.log(`订阅同步完成! 总耗时: ${fetchTime + (TESTING_CONFIG.enabled ? testTime : 0) + genTime}ms`);
    console.log('==================================================================');
          } catch (error) {
    console.error('==================================================================');
    console.error('同步过程中发生严重错误:');
    console.error(error);
    console.error(error.stack);
    
    // 尝试发送错误通知
    try {
      console.log('发送错误通知...');
      eventEmitter.emit(EventType.SYSTEM_ERROR, {
        message: `同步过程中发生严重错误: ${error.message}`,
        error: error.toString(),
        stack: error.stack
      });
      console.log('错误通知已触发');
    } catch (notifyError) {
      console.error('发送错误通知失败:', notifyError);
    }
    
    console.error('==================================================================');
    process.exit(1);
  }
}

// 执行主函数
main().catch(error => {
  console.error('同步过程中发生错误:', error);
  
  // 尝试发送错误通知
  try {
    eventEmitter.emit(EventType.SYSTEM_ERROR, {
      message: `同步过程中捕获到错误: ${error.message}`,
      error: error.toString(),
      stack: error.stack
    });
  } catch (e) {
    console.error('发送错误通知失败:', e);
  }
  
  process.exit(1);
});
