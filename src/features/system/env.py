import sys
import os

class Env:
    def __init__(self):
        self.base_dir = os.path.join(os.getcwd(), "env\\")
        self.git_dir = os.path.join(self.base_dir, "cmd\\")
        self.gitroot_dir = self.base_dir
        self.node_path = self.base_dir
        self.st_dir = os.path.join(os.getcwd(), "SillyTavern\\")
    def checkEnv(self):
        if not os.path.exists(self.base_dir):
            return 'Base dir is not exists'
        if not os.path.exists(self.git_dir):
            return 'Git dir is not exists'
        if not os.path.exists(self.node_path):
            return 'Node path is not exists'
        return True
    
    def get_git_path(self):
        return self.git_dir
    def  get_node_path(self):
        return self.node_path
    def checkST(self):
        if not os.path.exists(self.st_dir):
            return False
        else:
            if not os.path.isfile(os.path.join(self.st_dir, "package.json")):
                return False
            else:
                if not os.path.isfile(os.path.join(self.st_dir, "server.js")):
                    return False
                else:
                    return True
    def check_nodemodules(self):
        if not os.path.exists(os.path.join(self.st_dir, "node_modules")):
            return False
        else:
            return True