#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
直接转换CSV到简化JSON格式
"""

import csv
import json
import os

def main():
    """主函数"""
    print("正在转换CSV到简化JSON格式...")
    
    csv_file = 'job_details_with_text.csv'
    json_file = 'job_details_simple.json'
    
    # 检查输入文件
    if not os.path.exists(csv_file):
        print(f"错误: 找不到文件 {csv_file}")
        return
    
    try:
        # 读取CSV文件
        print(f"正在读取CSV文件: {csv_file}")
        jobs = []
        
        with open(csv_file, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            
            for row in reader:
                # 清理数据
                cleaned_job = {}
                for key, value in row.items():
                    if value is None or value == '' or value == 'nan':
                        cleaned_job[key] = ""
                    else:
                        cleaned_value = str(value).strip()
                        cleaned_value = cleaned_value.replace('\n', ' ').replace('\r', ' ')
                        cleaned_value = cleaned_value.replace('\t', ' ').replace('\\', '\\\\')
                        cleaned_value = ' '.join(cleaned_value.split())
                        cleaned_job[key] = cleaned_value
                
                jobs.append(cleaned_job)
        
        print(f"成功读取 {len(jobs)} 条职位记录")
        
        # 写入简化的JSON文件
        print(f"正在写入简化JSON文件: {json_file}")
        with open(json_file, 'w', encoding='utf-8') as f:
            json.dump(jobs, f, ensure_ascii=False, indent=2)
        
        print(f"✓ 成功转换并保存到: {json_file}")
        
        # 显示文件信息
        if os.path.exists(json_file):
            file_size = os.path.getsize(json_file)
            print(f"文件大小: {file_size / 1024:.2f} KB")
            print(f"包含 {len(jobs)} 个职位记录")
        
    except Exception as e:
        print(f"转换过程中出错: {e}")

if __name__ == "__main__":
    main()


