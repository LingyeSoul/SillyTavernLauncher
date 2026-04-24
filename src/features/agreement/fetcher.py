"""
Agreement fetcher module for fetching and caching user agreement content.
"""

import os
import re
import json
from datetime import datetime
from html.parser import HTMLParser
from typing import Optional

import requests

from utils.logger import app_logger


class _AgreementHTMLParser(HTMLParser):
    """HTML parser to extract content from agreement page."""

    def __init__(self):
        super().__init__()
        self._in_target_div = False
        self._div_depth = 0
        self._content_parts = []
        self._block_tags = {'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'div'}
        self._last_was_block = False

    def handle_starttag(self, tag: str, attrs: list):
        tag_lower = tag.lower()

        if tag_lower == 'div':
            class_name = ''
            for attr, val in attrs:
                if attr == 'class':
                    class_name = val
                    break

            if 'vp-doc' in class_name and '_agreement' in class_name:
                self._in_target_div = True
                self._div_depth = 1
                return

        if self._in_target_div:
            if tag_lower == 'div':
                self._div_depth += 1
            elif tag_lower in self._block_tags:
                if not self._last_was_block:
                    self._content_parts.append('\n\n')
                self._last_was_block = True
            elif tag_lower == 'br':
                self._content_parts.append('\n')
                self._last_was_block = False

    def handle_endtag(self, tag: str):
        tag_lower = tag.lower()

        if tag_lower == 'div' and self._in_target_div:
            self._div_depth -= 1
            if self._div_depth <= 0:
                self._in_target_div = False
                self._div_depth = 0
            else:
                if not self._last_was_block:
                    self._content_parts.append('\n\n')
                self._last_was_block = True

    def handle_data(self, data: str):
        if self._in_target_div:
            text = data.strip()
            if text:
                self._content_parts.append(text)
                self._last_was_block = False

    def get_content(self) -> str:
        """Get extracted text content."""
        content = ''.join(self._content_parts)
        content = re.sub(r'\n{3,}', '\n\n', content)
        return content.strip()


class AgreementFetcher:
    """Fetches and caches agreement content from remote URL."""

    AGREEMENT_URL = "https://sillytavern.lingyesoul.top/agreement"
    CACHE_FILE = "agreement_cache.json"

    def __init__(self):
        """Initialize agreement fetcher."""
        self._cache_path = os.path.join(os.getcwd(), self.CACHE_FILE)

    def fetch_agreement(self) -> str:
        """
        Fetch agreement HTML from remote URL.

        Returns:
            str: Raw HTML content

        Raises:
            requests.RequestException: If fetch fails
        """
        app_logger.info("正在获取协议内容...")
        response = requests.get(self.AGREEMENT_URL, timeout=5)
        response.raise_for_status()
        app_logger.info("协议内容获取成功")
        return response.text

    @staticmethod
    def parse_date_text(text: str) -> str:
        """
        Parse Chinese date format from text and return ISO format.

        Looks for pattern like "版本日期：2026年4月23日" or "版本日期:2026年4月23日"

        Args:
            text: Text containing Chinese date

        Returns:
            str: ISO format date "YYYY-MM-DD" or empty string if not found
        """
        # 先尝试带"版本日期"前缀的匹配
        pattern_with_prefix = r'版本日期[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日'
        match = re.search(pattern_with_prefix, text)

        if not match:
            # 回退：直接匹配中文日期格式
            pattern_bare = r'(\d{4})年(\d{1,2})月(\d{1,2})日'
            match = re.search(pattern_bare, text)

        if match:
            year, month, day = match.groups()
            return f"{year}-{int(month):02d}-{int(day):02d}"

        return ""

    def parse_date(self, html: str) -> str:
        """
        Parse date from agreement HTML.

        Args:
            html: HTML content

        Returns:
            str: ISO format date or empty string
        """
        return self.parse_date_text(html)

    def extract_content(self, html: str) -> str:
        """
        Extract text content from agreement HTML.

        Uses HTMLParser to find <div class="vp-doc _agreement"> and extract
        text content while preserving paragraph breaks.

        Args:
            html: HTML content

        Returns:
            str: Extracted text content
        """
        parser = _AgreementHTMLParser()
        parser.feed(html)
        return parser.get_content()

    def load_cache(self) -> Optional[dict]:
        """
        Load cached agreement data.

        Returns:
            dict: Cache data with keys 'date', 'content', 'fetched_at' or None if invalid
        """
        if not os.path.exists(self._cache_path):
            app_logger.debug("协议缓存文件不存在")
            return None

        try:
            with open(self._cache_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            if not all(key in data for key in ('date', 'content', 'fetched_at')):
                app_logger.warning("协议缓存文件格式无效")
                return None

            app_logger.debug(f"从缓存加载协议: {data.get('date', 'unknown')}")
            return data
        except Exception as e:
            app_logger.error(f"读取协议缓存失败: {e}", exc_info=True)
            return None

    def save_cache(self, date: str, content: str) -> None:
        """
        Save agreement data to cache.

        Args:
            date: ISO format date string
            content: Agreement text content
        """
        try:
            data = {
                "date": date,
                "content": content,
                "fetched_at": datetime.now().isoformat()
            }

            with open(self._cache_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

            app_logger.info("协议缓存已保存")
        except Exception as e:
            app_logger.error(f"保存协议缓存失败: {e}", exc_info=True)

    def get_agreement(self) -> tuple[str, str, bool]:
        """
        Get agreement content, fetching from network or cache.

        Returns:
            tuple: (date, content, from_cache)
                - date: ISO format date string
                - content: Agreement text content
                - from_cache: True if loaded from cache, False if fetched fresh

        Raises:
            RuntimeError: If both network fetch and cache load fail
        """
        try:
            html = self.fetch_agreement()
            date = self.parse_date(html)
            content = self.extract_content(html)

            if date and content:
                self.save_cache(date, content)
                return (date, content, False)
            else:
                app_logger.warning("协议解析结果不完整，尝试使用缓存")

        except Exception as e:
            app_logger.error(f"获取协议失败: {e}", exc_info=True)

        cached = self.load_cache()
        if cached:
            app_logger.info("使用缓存的协议内容")
            return (cached['date'], cached['content'], True)

        raise RuntimeError("无法获取协议内容且无本地缓存")
