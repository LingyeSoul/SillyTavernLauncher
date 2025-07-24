import os
from ruamel.yaml import YAML


class stcfg:
    def __init__(self):
        self.base_dir = os.path.join(os.getcwd(), "SillyTavern")
        self.config_path = os.path.join(self.base_dir, "config.yaml")
        self.whitelist_path = os.path.join(self.base_dir, "whitelist.txt")
        self.listen = False
        self.port = 8000
        self.proxy_enabled = False
        self.proxy_url = ""
        
        # 初始化YAML处理对象
        self.yaml = YAML()
        self.yaml.preserve_quotes = True
            
        self.config_data = {}
        self.load_config()

    def load_config(self):
        try:
            with open(self.config_path, 'r', encoding='utf-8') as file:
                self.config_data = self.yaml.load(file) or {}
                    
                # 保留原始配置内容
                self.listen = self.config_data.get('listen', False)
                self.port = self.config_data.get('port', 8000)
                # 加载requestProxy配置
                request_proxy = self.config_data.get('requestProxy', {})
                self.proxy_enabled = request_proxy.get('enabled', False)
                self.proxy_url = request_proxy.get('url', "")
        except Exception as e:
            print(f"配置加载错误: {str(e)}")
            self.config_data = {
                'listen': self.listen,
                'port': self.port
            }


    def save_config(self):
        try:
            # 确保目标目录 exist
            os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
            # 仅更新需要修改的字段
            self.config_data['listen'] = self.listen
            self.config_data['port'] = self.port
            # 保存requestProxy配置
            if 'requestProxy' not in self.config_data:
                self.config_data['requestProxy'] = {}
            self.config_data['requestProxy']['enabled'] = self.proxy_enabled
            self.config_data['requestProxy']['url'] = self.proxy_url
            
            with open(self.config_path, 'w', encoding='utf-8') as file:
                self.yaml.dump(self.config_data, file)

            
        except Exception as e:
            print(f"配置保存失败: {str(e)}")

    def create_whitelist(self):
        if not os.path.exists(self.whitelist_path):
            try:
                # 确保目标目录存在
                os.makedirs(os.path.dirname(self.whitelist_path), exist_ok=True)
                with open(self.whitelist_path, 'w', encoding='utf-8') as f:
                    f.write("192.168.*.*\n127.0.0.1\n")
            except Exception as e:
                print(f"白名单文件创建失败: {str(e)}")
