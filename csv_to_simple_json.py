#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CSV转简化JSON工具
将job_details_with_text.csv转换为简化的JSON格式
"""

import csv
import json
import os

def main():
    """主函数"""
    print("CSV转简化JSON工具")
    print("="*50)
    
    # 输入和输出文件
    csv_file = 'job_details_with_text.csv'
    json_file = 'job_details_simple.json'
    
    # 检查输入文件
    if not os.path.exists(csv_file):
        print(f"错误: 找不到输入文件 {csv_file}")
        print("请确保该文件存在于当前目录中")
        return
    
    print(f"找到输入文件: {csv_file}")
    
    try:
        # 读取CSV文件
        print("正在读取CSV文件...")
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
                        # 清理特殊字符
                        cleaned_value = cleaned_value.replace('\n', ' ').replace('\r', ' ')
                        cleaned_value = cleaned_value.replace('\t', ' ').replace('\\', '\\\\')
                        cleaned_value = ' '.join(cleaned_value.split())  # 合并多个空格
                        cleaned_job[key] = cleaned_value
                
                jobs.append(cleaned_job)
        
        print(f"成功读取 {len(jobs)} 条职位记录")
        
        # 写入简化的JSON文件
        print(f"正在写入JSON文件: {json_file}")
        with open(json_file, 'w', encoding='utf-8') as f:
            json.dump(jobs, f, ensure_ascii=False, indent=2)
        
        print(f"✓ 成功转换并保存到: {json_file}")
        
        # 显示文件信息
        if os.path.exists(json_file):
            file_size = os.path.getsize(json_file)
            print(f"文件大小: {file_size / 1024:.2f} KB")
            print(f"包含 {len(jobs)} 个职位记录")
            
            # 显示前几条记录的结构
            if jobs:
                print(f"\nJSON结构预览 (前3条记录):")
                print("-" * 50)
                for i, job in enumerate(jobs[:3], 1):
                    print(f"\n记录 {i}:")
                    for key, value in job.items():
                        display_value = value[:80] + "..." if len(value) > 80 else value
                        print(f"  {key}: {display_value}")
        
    except Exception as e:
        print(f"转换过程中出错: {e}")
        print("请检查文件格式和权限")

if __name__ == "__main__":
    main()
