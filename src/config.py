import json
import os


class ConfigManager:
    def __init__(self, config_path=None):
        """
        初始化配置管理器
        
        Args:
            config_path (str, optional): 配置文件路径，默认为当前目录下的config.json
        """
        if config_path is None:
            self.config_path = os.path.join(os.getcwd(), "config.json")
        else:
            self.config_path = config_path
        self.default_config = {
                "patchgit": False,
                "use_sys_env": self._detect_env_type(),
                "theme": "dark",
                "first_run": True,
                "github": {"mirror": "gh.llkk.cc"},
                "log": True,
                "checkupdate": True,
                "stcheckupdate": False,
            }   
        self.config = self.load_config()
        
        
    def load_config(self):
        """
        加载配置文件
        
        Returns:
            dict: 配置字典
        """
        # 如果配置文件不存在，创建默认配置
        if not os.path.exists(self.config_path):

            self.save_config(self.default_config)
            return self.default_config
        
        # 读取现有配置
        try:
            with open(self.config_path, "r") as f:
                return json.load(f)
        except Exception as e:
            # 如果读取失败，返回默认配置
            return self.default_config
    
    def save_config(self, config_data=None):
        """
        保存配置到文件
        
        Args:
            config_data (dict, optional): 要保存的配置数据，默认使用实例中的config
        """
        if config_data is None:
            config_data = self.config
            
        try:
            with open(self.config_path, "w") as f:
                json.dump(config_data, f, indent=4)
        except Exception as e:
            raise Exception(f"保存配置文件失败: {str(e)}")
    
    def get(self, key, default=None):
        """
        获取配置项的值
        
        Args:
            key (str): 配置项键名，支持点号分隔的嵌套键名，如 "github.mirror"
            default: 默认值
            
        Returns:
            配置项的值或默认值
        """
        keys = key.split('.')
        value = self.config
        
        try:
            for k in keys:
                value = value[k]
            return value
        except (KeyError, TypeError):
            return default
    
    def set(self, key, value):
        """
        设置配置项的值
        
        Args:
            key (str): 配置项键名，支持点号分隔的嵌套键名，如 "github.mirror"
            value: 要设置的值
        """
        keys = key.split('.')
        config_data = self.config
        
        # 逐层导航到目标位置
        for k in keys[:-1]:
            if k not in config_data or not isinstance(config_data[k], dict):
                config_data[k] = {}
            config_data = config_data[k]
        
        # 设置最终值
        config_data[keys[-1]] = value
    
    def update(self, updates):
        """
        批量更新配置项
        
        Args:
            updates (dict): 要更新的配置项字典
        """
        for key, value in updates.items():
            self.set(key, value)
    
    def reload(self):
        """
        重新加载配置文件
        """
        self.config = self.load_config()
    
    def _detect_env_type(self):
        """
        检测环境类型（是否使用系统环境）
        
        Returns:
            bool: True表示使用系统环境，False表示使用内置环境
        """
        if os.path.exists(os.path.join(os.getcwd(), "env\\")):
            return False
        else:
            return True


# 全局配置管理器实例
config_manager = ConfigManager()